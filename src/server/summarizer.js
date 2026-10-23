/**
 * 摘要与提炼：全部通过 LLM 完成，输出失败时均有确定性降级方案。
 *
 *   buildMemoryDigest()  新会话时把历史记忆压缩成简要摘要（注入上下文最前部）
 *   extractMemories()    会话结束（显式 / 超时）时提炼重要记忆
 *   rollSummary()        上下文超窗时对早期对话做增量滚动摘要
 */

import { getJson, putJson, K } from './repository.js';
import { extractJson } from './llm/deepseek.js';
import { clampImportance } from './llm/tools.js';
import { truncate, now } from './lib/util.js';

const DIGEST_CACHE_TTL_SECONDS = 3600;

/** 无 LLM 时的确定性压缩：直接按重要性挑选原文。 */
function heuristicDigest(items, maxChars) {
  const lines = [];
  let total = 0;
  for (const it of items) {
    const line = `- ${truncate(it.content, 80)}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}

export class Summarizer {
  constructor({ llm, cfg, memoryEngine, log } = {}) {
    this.llm = llm;
    this.cfg = cfg;
    this.memoryEngine = memoryEngine;
    this.log = log || (() => {});
  }

  /**
   * 生成记忆摘要。带 KV 缓存（写入记忆时失效）。
   * @returns {Promise<{text:string, cached:boolean, source:'llm'|'heuristic', ids:string[]}>}
   */
  async buildMemoryDigest({ userId, query = '', force = false }) {
    const cacheKey = K.memoryDigest(userId);
    if (!force) {
      const cached = await getJson(this.memoryEngine.store, cacheKey, null);
      if (cached && cached.text !== undefined && cached.expires > now()) {
        return { ...cached, cached: true };
      }
    }

    const { items } = await this.memoryEngine.selectForInjection({ userId, query });
    if (!items.length) {
      const empty = { text: '', cached: false, source: 'none', ids: [], expires: 0 };
      return empty;
    }

    const maxChars = Number(this.cfg.MEMORY_INJECT_MAX_CHARS) || 1800;
    let text = '';
    let source = 'llm';

    if (this.llm?.configured && items.length > 1) {
      const bullet = items.map((it, i) => `${i + 1}. ${it.content}`).join('\n');
      const res = await this.llm.chat(
        [
          {
            role: 'system',
            content: [
              '你是记忆压缩器。把给出的长期记忆合并成一段不超过 ' + maxChars + ' 字的简体中文摘要。',
              '要求：保留所有稳定事实、偏好、长期目标与禁忌；去掉重复与一次性事件；用第二人称「用户」称呼；',
              '不要添加原文没有的内容；不要使用 Markdown 标题，输出为「- 要点」项目符号列表，每行一条。',
            ].join('\n'),
          },
          { role: 'user', content: `记忆列表：\n${bullet}` },
        ],
        { temperature: 0.2, maxTokens: 1200, model: this.cfg.DEEPSEEK_MEMORY_MODEL || undefined, retry: false },
      ).catch((e) => {
        this.log('warn', 'summary:digest:llm_failed', { error: e.message });
        return null;
      });

      if (res?.content) text = String(res.content).trim();
    }

    if (!text) {
      text = heuristicDigest(items, maxChars);
      source = 'heuristic';
    }
    text = truncate(text, maxChars, '');

    const result = { text, ids: items.map((i) => i.id), source, expires: now() + DIGEST_CACHE_TTL_SECONDS * 1000 };
    await putJson(this.memoryEngine.store, cacheKey, result, DIGEST_CACHE_TTL_SECONDS);
    return { ...result, cached: false };
  }

  /**
   * 会话结束时提炼重要记忆。
   * @param {object} session 会话记录
   * @returns {Promise<Array<{content:string,category:string,importance:number,tags:string[]}>>}
   */
  async extractMemories(session) {
    if (this.cfg.MEMORY_EXTRACT_ENABLED === false) return [];
    const transcript = transcriptOf(session);
    if (!transcript.trim()) return [];

    if (!this.llm?.configured) {
      // 降级：抽取用户侧包含「我是 / 我喜欢 / 我不要 / 记住」等句式的句子
      return heuristicExtract(session, Number(this.cfg.MEMORY_EXTRACT_MAX) || 8);
    }

    const schemaHint = '{"memories":[{"content":"...","category":"profile|preference|goal|constraint|relationship|fact","importance":1-5,"tags":["..."]}]}';
    const max = Number(this.cfg.MEMORY_EXTRACT_MAX) || 8;
    const res = await this.llm.chat(
      [
        {
          role: 'system',
          content: [
            '你是长期记忆提炼器。阅读一段对话，抽取值得长期记住的关于「用户」的信息。',
            '只抽取稳定事实、长期偏好、长期目标、明确禁忌与重要人物关系；不要抽取一次性问答、临时任务、情绪性表达。',
            `最多 ${max} 条，每条 content 不超过 80 字，主语统一用「用户」，去掉时间敏感表述。`,
            '仅输出 JSON：' + schemaHint,
          ].join('\n'),
        },
        { role: 'user', content: `对话记录：\n${truncate(transcript, 12000)}` },
      ],
      {
        temperature: 0.1,
        maxTokens: 1200,
        jsonMode: true,
        model: this.cfg.DEEPSEEK_MEMORY_MODEL || undefined,
        retry: false,
      },
    ).catch((e) => {
      this.log('warn', 'summary:extract:llm_failed', { error: e.message });
      return null;
    });

    const parsed = parseList(res?.content);
    if (!parsed.length) return heuristicExtract(session, max);
    return parsed.slice(0, max).map((m) => ({
      content: truncate(String(m.content || '').trim(), 200),
      category: ['profile', 'preference', 'goal', 'constraint', 'relationship', 'fact'].includes(m.category) ? m.category : 'fact',
      importance: clampImportance(m.importance, 3),
      tags: Array.isArray(m.tags) ? m.tags.map(String).slice(0, 6) : [],
    })).filter((m) => m.content);
  }

  /** 上下文超窗时，把被挤出的早期对话压缩为滚动摘要（增量）。 */
  async rollSummary({ previousSummary, droppedMessages }) {
    if (this.cfg.SESSION_SUMMARY_ENABLED === false) return previousSummary || '';
    if (!droppedMessages?.length) return previousSummary || '';
    const addition = droppedMessages
      .map((m) => `${m.role === 'user' ? '用户' : '助理'}：${truncate(m.content, 300)}`)
      .join('\n');
    if (!this.llm?.configured) return truncate(`${previousSummary || ''}\n${addition}`.trim(), 2000);

    const res = await this.llm.chat(
      [
        {
          role: 'system',
          content: [
            '把「旧摘要」与「新增对话」合并为一份不超过 600 字的简体中文摘要。',
            '保留：用户提出的核心诉求、已给出的结论与承诺、尚未解决的问题、用户表达的偏好。',
            '丢弃：寒暄、重复表述、工具调用细节。直接输出摘要正文，不要任何前缀说明。',
          ].join('\n'),
        },
        { role: 'user', content: `旧摘要：\n${previousSummary || '（无）'}\n\n新增对话：\n${addition}` },
      ],
      {
        temperature: 0.2,
        maxTokens: 900,
        model: this.cfg.DEEPSEEK_MEMORY_MODEL || undefined,
        retry: false,
      },
    ).catch(() => null);

    return truncate(res?.content?.trim() || `${previousSummary || ''}\n${addition}`.trim(), 2000);
  }
}

export function transcriptOf(session) {
  const rows = [];
  for (const m of session?.messages || []) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') continue;
    const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助理' : m.role;
    rows.push(`${who}：${String(m.content || '').replace(/【用户消息[开始结束]】/g, '').trim()}`);
  }
  return rows.join('\n');
}

function parseList(content) {
  const text = extractJson(content);
  if (!text) return [];
  try {
    const obj = JSON.parse(text);
    const arr = Array.isArray(obj) ? obj : Array.isArray(obj.memories) ? obj.memories : Array.isArray(obj.items) ? obj.items : null;
    return Array.isArray(arr) ? arr : [];
  } catch {
    // 尝试逐行提取
    return String(text)
      .split('\n')
      .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
      .filter((l) => l.length > 3 && l.length < 120)
      .map((l) => ({ content: l, importance: 3 }));
  }
}

const EXTRACT_PATTERNS = [
  /(我是|我叫|我住|我在|我的名字是)[^\n，。！？]{2,40}/g,
  /(我喜欢|我讨厌|我不想|我不要|我讨厌|我偏好)[^\n，。！？]{2,40}/g,
  /(请记住|记住|别忘了)[^\n，。！？]{2,60}/g,
  /(我的目标是|我打算|我希望)[^\n，。！？]{2,60}/g,
];

function heuristicExtract(session, max) {
  const out = [];
  for (const m of session?.messages || []) {
    if (m.role !== 'user') continue;
    const text = String(m.content || '').replace(/【用户消息[开始结束]】/g, '');
    for (const re of EXTRACT_PATTERNS) {
      for (const hit of text.matchAll(re)) {
        if (hit[0]) out.push({ content: hit[0].trim(), category: 'fact', importance: 3, tags: ['heuristic'] });
      }
    }
  }
  return out.slice(0, max);
}
