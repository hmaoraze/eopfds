/**
 * 面向模型的工具定义与执行器。
 *
 * 三条写记忆路径统一收敛到 MemoryEngine.write()：
 *   1) function calling：save_memory / end_session / search_memory
 *   2) 文本约定指令：模型在正文里输出 #MEMORY#{...}# 块
 *   3) 会话结束（显式 / 超时）时的自动提炼
 */

import { extractJson } from './deepseek.js';

/** OpenAI / DeepSeek function-calling 工具定义。 */
export function buildToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'save_memory',
        description: '保存一条关于该用户的长期记忆（稳定事实、偏好、长期目标、禁忌事项）。当用户透露可复用的个人信息时务必调用。',
        parameters: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', description: '一句话写清事实或偏好，主语用「用户」，不要包含时间敏感内容' },
            category: {
              type: 'string',
              enum: ['profile', 'preference', 'goal', 'constraint', 'relationship', 'fact'],
              description: '记忆类别',
            },
            importance: { type: 'integer', minimum: 1, maximum: 5, description: '1=琐碎，5=必须长期保留' },
            tags: { type: 'array', items: { type: 'string' }, description: '便于检索的关键词' },
            ttlDays: { type: 'integer', description: '可选，过期天数；不填使用全局默认' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'end_session',
        description: '结束当前会话（用户明确告别、话题彻底完结或用户要求清空上下文时调用）。结束后系统会自动提炼并保存重要记忆。',
        parameters: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', description: '简短的结束原因，例如「用户告别」「开始新话题」' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_memory',
        description: '在用户的长期记忆中检索与查询相关的内容。当回答可能受用户过往信息影响时使用。',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: '检索关键词或问题' },
            limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 5' },
          },
        },
      },
    },
  ];
}

const MEMORY_BLOCK = /#MEMORY#\s*([\s\S]{0,4000}?)\s*#\s*(?:MEMORY)?/g;

/** 从模型正文中剥离 #MEMORY#{...}# 指令块，返回清洗后的文本与解析出的指令列表。 */
export function parseTextMemoryCommands(text) {
  const commands = [];
  if (!text) return { cleanText: '', commands };
  let clean = String(text);
  for (const match of String(text).matchAll(MEMORY_BLOCK)) {
    const payload = extractJson(match[1]);
    if (!payload) continue;
    try {
      const obj = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (obj && typeof obj === 'object' && obj.content) commands.push(obj);
    } catch { /* 忽略非法块 */ }
  }
  if (commands.length) clean = clean.replace(MEMORY_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText: clean, commands };
}

/**
 * @param {object} deps { cfg, memoryEngine, sessionService, sessionId, userId, log }
 */
export function createToolExecutor(deps) {
  const { cfg, memoryEngine, sessionService, log } = deps;

  return {
    async run(toolCall) {
      const name = toolCall?.function?.name;
      const args = parseArgs(toolCall?.function?.arguments);
      switch (name) {
        case 'save_memory': {
          if (!args.content || !String(args.content).trim()) {
            return toolResult(toolCall.id, { ok: false, error: 'content 不能为空' });
          }
          const item = await memoryEngine.write({
            userId: deps.userId,
            content: String(args.content).trim(),
            category: args.category || 'fact',
            importance: clampImportance(args.importance, 3),
            tags: Array.isArray(args.tags) ? args.tags.map(String).slice(0, 8) : [],
            ttlDays: Number(args.ttlDays) > 0 ? Number(args.ttlDays) : undefined,
            source: 'tool',
            sessionId: deps.sessionId,
          });
          deps.recordMemory?.(item);
          log?.('info', 'tool:save_memory', { userId: deps.userId, id: item.id });
          return toolResult(toolCall.id, { ok: true, memoryId: item.id, saved: item.content, merged: Boolean(item.mergedWith) });
        }

        case 'end_session': {
          await sessionService.requestEnd({ userId: deps.userId, sessionId: deps.sessionId, reason: `tool:${args.reason || 'model'}` });
          deps.markSessionEnded?.();
          log?.('info', 'tool:end_session', { userId: deps.userId, reason: args.reason });
          return toolResult(toolCall.id, { ok: true, ended: true });
        }

        case 'search_memory': {
          const hits = await memoryEngine.query({
            userId: deps.userId,
            query: String(args.query || ''),
            limit: Math.min(20, Math.max(1, Number(args.limit) || 5)),
          });
          return toolResult(toolCall.id, {
            ok: true,
            memories: hits.map((h) => ({ id: h.id, content: h.content, importance: h.importance, updatedAt: h.updatedAt })),
          });
        }

        default:
          return toolResult(toolCall.id, { ok: false, error: `未知工具 ${name}` });
      }
    },
  };
}

function toolResult(toolCallId, payload) {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    name: undefined,
    content: JSON.stringify(payload),
  };
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function clampImportance(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(5, Math.max(1, Math.round(n)));
}
