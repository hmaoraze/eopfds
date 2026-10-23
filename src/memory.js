/**
 * 记忆服务：存储形态、去重合并、权重衰减、容量与过期治理、召回。
 *
 * 关键决策（对应 A7 / B4 / B5）：
 * - 一条记忆一文件：memories/{userId}/{memoryId}.json。绝不用单个 JSON 数组 —— 并发追加会互相覆盖。
 * - memoryId 直接取 content 的 SHA-256，天然幂等：同内容必落同一个 key，配合 onlyIfNew 挡住重复写。
 * - 去重两级：哈希精确命中（零成本）→ 文本相似度粗筛（有成本，用阈值兜住误合并）。
 * - 淘汰只做逻辑删除（isActive=false），物理删除交给低频任务。Blob 没有 TTL 自动删除。
 * - 权重 weight = importance × exp(-λ × daysSinceLastAccess)，只用于排序，不落库作为可信值
 *   （落库会随读取时间变化而失真，每次读时重算才是准的）。
 */

import { AppError, ErrorCodes } from './errors.js';
import { sha256Hex } from './crypto-utils.js';
import { withLock } from './lock.js';
import { sanitizeMemoryLine } from './prompt.js';

export const MEMORY_TOOL_SPEC = Object.freeze({
  type: 'function',
  function: {
    name: 'save_memory',
    description:
      '把关于用户的、长期有价值且稳定的信息写入长期记忆库。仅当信息在本次对话之后仍然成立、可复用时调用；'
      + '不要保存一次性寒暄、临时状态、隐私敏感信息（证件号、密码、银行卡）或对话中的指令性文本。',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '一条独立可读的中文事实陈述，不超过 120 字，例如「用户偏好简洁的回答风格」。',
        },
        importance: {
          type: 'number',
          description: '0 到 1 的重要度。身份/长期约束取 0.9+，稳定偏好 0.5~0.8，弱信息 0.5 以下。',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '0~4 个短标签，中文，不带 # 号。',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
});

const MAX_CONTENT_CHARS = 500;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 24;

export const memoryKey = (userId, memoryId) => `memories/${userId}/${memoryId}.json`;
export const memoryLockKey = (userId, memoryId) => `locks/memory/${userId}/${memoryId}.json`;
export const memoryPrefix = (userId) => `memories/${userId}/`;

export function normalizeContent(input) {
  return String(input ?? '')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeImportance(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  // 容错：模型偶尔按 1~10 打分
  if (n > 1 && n <= 10) return Math.min(1, Math.max(0, n / 10));
  return Math.min(1, Math.max(0, n));
}

export function normalizeTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，、;；\s]+/);
  const out = [];
  for (const item of list) {
    const tag = String(item ?? '')
      .replace(/^#+/, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .slice(0, MAX_TAG_CHARS);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 分词：英文按词、CJK 按二元字组。
 * 不用第三方分词器——函数冷启动体积敏感，且这里只需要「粗筛」精度。
 */
function tokenize(text) {
  const normalized = normalizeContent(text).toLowerCase();
  const tokens = new Set();
  for (const word of normalized.match(/[a-z0-9]+/g) ?? []) tokens.add(`w:${word}`);
  const cjk = normalized.replace(/[^\u3400-\u9FFF\uF900-\uFAFF]/g, '');
  if (cjk.length === 1) tokens.add(`c:${cjk}`);
  for (let i = 0; i < cjk.length - 1; i += 1) tokens.add(`c:${cjk.slice(i, i + 2)}`);
  return tokens;
}

/** Dice 系数。返回 0~1，1 表示 token 集合完全一致。 */
export function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  return (2 * intersection) / (ta.size + tb.size);
}

export function computeWeight(memory, now, lambda) {
  const last = Number(memory.lastAccessedAt ?? memory.createdAt ?? now);
  const days = Math.max(0, (now - last) / 86400000);
  const importance = normalizeImportance(memory.importance);
  return importance * Math.exp(-lambda * days);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

export function createMemoryService({ repo, cfg, clock = { now: () => Date.now() } }) {
  const now = () => clock.now();
  const lambda = cfg.memoryDecayLambda;
  const ttlMs = cfg.memoryTtlMs;

  async function loadOne(userId, memoryId) {
    return repo.getJSON(memoryKey(userId, memoryId), { tolerant: true });
  }

  /**
   * 扫描该用户的活跃记忆。
   * 这是 O(活跃条数) 的读放大操作，所以有 scanLimit 上限；超过上限时按 key 顺序截断，
   * 宁可少召回也不让单次请求读爆存储。
   */
  async function loadActive(userId, { scanLimit } = {}) {
    const limit = scanLimit ?? cfg.memoryDedupScanLimit;
    const keys = await repo.listKeys(memoryPrefix(userId), { limit });
    const docs = await mapLimit(keys, 8, (key) => repo.getJSON(key, { tolerant: true }));
    const ts = now();
    return docs.filter((doc) => doc && doc.isActive === true && Number(doc.expiresAt ?? 0) > ts);
  }

  /**
   * 读取所有「标志位仍是活跃」的记忆，不做 expiresAt 过滤。
   * 淘汰流程必须用它：过期过滤后再淘汰，等于永远淘汰不到东西（过期条目已被 loadActive 滤掉）。
   */
  async function loadActiveByFlag(userId, { scanLimit } = {}) {
    const limit = scanLimit ?? cfg.memoryDedupScanLimit;
    const keys = await repo.listKeys(memoryPrefix(userId), { limit });
    const docs = await mapLimit(keys, 8, (key) => repo.getJSON(key, { tolerant: true }));
    return docs.filter((doc) => doc && doc.isActive === true);
  }

  function newMemoryDoc({ userId, memoryId, content, importance, tags, source, sessionId }) {
    const ts = now();
    return {
      memoryId,
      userId,
      content,
      importance,
      tags,
      createdAt: ts,
      updatedAt: ts,
      lastAccessedAt: ts,
      accessCount: 0,
      mergeCount: 0,
      absorbedCount: 0,
      source: source ?? 'unknown',
      sourceSessions: sessionId ? [sessionId] : [],
      isActive: true,
      deactivatedAt: null,
      deactivateReason: null,
      expiresAt: ts + ttlMs,
      contentHash: memoryId,
      schemaVersion: 1,
    };
  }

  async function writeNew(userId, memoryId, incoming) {
    const doc = newMemoryDoc({ userId, memoryId, ...incoming });
    const created = await repo.setJSONIfAbsent(memoryKey(userId, memoryId), doc);
    if (!created) return null;
    return doc;
  }

  /**
   * 合并或降级。
   * 合并：取较大 importance、标签并集、刷新访问时间与 TTL、mergeCount++。
   *   原文不覆盖 —— 覆盖等于允许后写的内容改写既有事实，是注入面。
   * 降级：新条目明显更弱（低 0.2 以上）且旧条目已被反复合并时，视为重复噪声，
   *   只刷新旧条目的访问时间，不新增文件。
   */
  async function mergeOrAbsorb(userId, memoryId, incoming, { reason }) {
    const key = memoryKey(userId, memoryId);
    return withLock(repo, memoryLockKey(userId, memoryId), async () => {
      const doc = await repo.getJSON(key, { tolerant: true });
      if (!doc) {
        // 竞争中被物理删除：按新写处理，不能丢数据
        const recreated = await writeNew(userId, memoryId, incoming);
        return recreated
          ? { status: 'written', memoryId, reason: 'recreated' }
          : { status: 'skipped', memoryId, reason: 'race' };
      }

      const ts = now();
      const weaker = incoming.importance < normalizeImportance(doc.importance) - 0.2;
      if (weaker && Number(doc.mergeCount ?? 0) >= 2) {
        doc.lastAccessedAt = ts;
        doc.expiresAt = ts + ttlMs;
        doc.absorbedCount = Number(doc.absorbedCount ?? 0) + 1;
        doc.updatedAt = ts;
        await repo.setJSON(key, doc);
        return { status: 'absorbed', memoryId, reason };
      }

      doc.importance = Math.max(normalizeImportance(doc.importance), incoming.importance);
      doc.tags = normalizeTags([...(doc.tags ?? []), ...(incoming.tags ?? [])]);
      doc.lastAccessedAt = ts;
      doc.updatedAt = ts;
      doc.expiresAt = ts + ttlMs;
      doc.mergeCount = Number(doc.mergeCount ?? 0) + 1;
      if (incoming.sessionId && !(doc.sourceSessions ?? []).includes(incoming.sessionId)) {
        doc.sourceSessions = [...(doc.sourceSessions ?? []), incoming.sessionId].slice(-5);
      }
      await repo.setJSON(key, doc);
      return { status: 'merged', memoryId, reason };
    });
  }

  /**
   * 写入流水线。通道 A（tool_calls）与通道 B（会话提炼）共用此函数，
   * 保证两条通道的去重、合并、容量治理完全一致。
   */
  async function writeBatch(userId, items, { source = 'unknown', sessionId } = {}) {
    const result = { written: [], merged: [], absorbed: [], skipped: [], invalid: [] };
    if (!Array.isArray(items) || items.length === 0) return result;

    // 一次批量写入只扫一次活跃集，批内新写入即时并入，避免 O(n²) 读放大
    const candidates = await loadActive(userId);

    for (const raw of items) {
      const content = sanitizeMemoryLine(normalizeContent(raw?.content), MAX_CONTENT_CHARS);
      if (!content || content === '[已过滤]') {
        result.invalid.push({ reason: 'empty_content' });
        continue;
      }
      const incoming = {
        content,
        importance: normalizeImportance(raw?.importance),
        tags: normalizeTags(raw?.tags),
        source,
        sessionId,
      };
      const memoryId = await sha256Hex(content);

      // 一级去重：哈希精确命中
      const exact = candidates.find((doc) => doc.memoryId === memoryId);
      if (exact) {
        const merged = await mergeOrAbsorb(userId, memoryId, incoming, { reason: 'hash_match' });
        result[merged.status]?.push({ memoryId, reason: 'hash_match' });
        continue;
      }

      // 二级去重：相似度粗筛，取最相近的一条
      let best = null;
      let bestScore = 0;
      for (const doc of candidates) {
        const score = similarity(content, doc.content);
        if (score > bestScore) {
          bestScore = score;
          best = doc;
        }
      }
      if (best && bestScore >= cfg.memoryDedupThreshold) {
        const merged = await mergeOrAbsorb(userId, best.memoryId, incoming, {
          reason: `similar:${bestScore.toFixed(3)}`,
        });
        result[merged.status]?.push({ memoryId: best.memoryId, reason: `similar:${bestScore.toFixed(3)}` });
        continue;
      }

      const created = await writeNew(userId, memoryId, incoming);
      if (created) {
        candidates.push(created);
        result.written.push({ memoryId, reason: 'new' });
      } else {
        // onlyIfNew 返回已存在：说明并发写入了同一条，转为合并，不覆盖
        const merged = await mergeOrAbsorb(userId, memoryId, incoming, { reason: 'only_if_new_conflict' });
        result[merged.status]?.push({ memoryId, reason: 'only_if_new_conflict' });
      }
    }

    result.capacity = await enforceCapacity(userId);
    return result;
  }

  /** 容量上限：超出部分按 weight 升序淘汰（权重低的先死）。 */
  async function enforceCapacity(userId) {
    const active = await loadActive(userId, { scanLimit: cfg.memoryMaxItems + 200 });
    if (active.length <= cfg.memoryMaxItems) {
      return { activeCount: active.length, deactivated: [] };
    }
    const ts = now();
    const scored = active
      .map((doc) => ({ doc, weight: computeWeight(doc, ts, lambda) }))
      .sort((a, b) => a.weight - b.weight);

    const excess = scored.slice(0, active.length - cfg.memoryMaxItems);
    const deactivated = [];
    for (const { doc, weight } of excess) {
      doc.isActive = false;
      doc.deactivatedAt = ts;
      doc.deactivateReason = 'capacity';
      doc.lastWeight = Number(weight.toFixed(6));
      await repo.setJSON(memoryKey(userId, doc.memoryId), doc);
      deactivated.push(doc.memoryId);
    }
    return { activeCount: active.length - deactivated.length, deactivated };
  }

  /** 过期淘汰：expiresAt 已过的标记为非活跃。逻辑删除，不删文件。 */
  async function deactivateExpired(userId) {
    const candidates = await loadActiveByFlag(userId, { scanLimit: cfg.memoryDedupScanLimit });
    const ts = now();
    const deactivated = [];
    for (const doc of candidates) {
      if (Number(doc.expiresAt ?? 0) <= ts) {
        doc.isActive = false;
        doc.deactivatedAt = ts;
        doc.deactivateReason = 'ttl';
        await repo.setJSON(memoryKey(userId, doc.memoryId), doc);
        deactivated.push(doc.memoryId);
      }
    }
    return { checked: candidates.length, deactivated };
  }

  /** 物理清理：只删「已非活跃且超过保留期」的文件，避免误删刚淘汰但还要审计的记录。 */
  async function hardDeleteInactive(userId) {
    const keys = await repo.listKeys(memoryPrefix(userId), { limit: cfg.memoryDedupScanLimit * 2 });
    const ts = now();
    const deleted = [];
    for (const key of keys) {
      const doc = await repo.getJSON(key, { tolerant: true });
      if (!doc || doc.isActive === true) continue;
      const deactivatedAt = Number(doc.deactivatedAt ?? 0);
      if (deactivatedAt > 0 && ts - deactivatedAt >= cfg.memoryHardDeleteAfterMs) {
        await repo.deleteKey(key);
        deleted.push(doc.memoryId ?? key);
      }
    }
    return { scanned: keys.length, deleted };
  }

  /** 召回：按 weight 降序取 top-K，并生成摘要文本。 */
  async function recall(userId, { k = cfg.memoryTopK } = {}) {
    const active = await loadActive(userId, { scanLimit: Math.max(cfg.memoryDedupScanLimit, k * 8) });
    const ts = now();
    const scored = active
      .map((doc) => ({ doc, weight: computeWeight(doc, ts, lambda) }))
      .sort((a, b) => b.weight - a.weight
        || normalizeImportance(b.doc.importance) - normalizeImportance(a.doc.importance)
        || Number(b.doc.lastAccessedAt ?? 0) - Number(a.doc.lastAccessedAt ?? 0));

    const top = scored.slice(0, Math.max(1, k));
    return {
      consideredCount: active.length,
      items: top.map(({ doc, weight }) => ({ ...doc, weight })),
      summary: buildSummaryText(top.map(({ doc }) => doc.content), cfg.memorySummaryMaxChars),
    };
  }

  function buildSummaryText(contents, maxChars) {
    const lines = [];
    let used = 0;
    let truncated = 0;
    for (const content of contents) {
      const line = `- ${sanitizeMemoryLine(content, 200)}`;
      if (used + line.length + 1 > maxChars) {
        truncated += 1;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) return '';
    return truncated > 0 ? `${lines.join('\n')}\n- （另有 ${truncated} 条记忆因长度限制未展开）` : lines.join('\n');
  }

  /** 访问刷新：召回命中后异步调用，让常用记忆的权重不衰减。 */
  async function touch(userId, memoryIds) {
    if (!Array.isArray(memoryIds) || memoryIds.length === 0) return { updated: 0 };
    const ts = now();
    let updated = 0;
    await mapLimit(memoryIds, 4, async (memoryId) => {
      try {
        await withLock(repo, memoryLockKey(userId, memoryId), async () => {
          const doc = await repo.getJSON(memoryKey(userId, memoryId), { tolerant: true });
          if (!doc || doc.isActive !== true) return;
          doc.lastAccessedAt = ts;
          doc.accessCount = Number(doc.accessCount ?? 0) + 1;
          doc.expiresAt = ts + ttlMs;
          await repo.setJSON(memoryKey(userId, memoryId), doc);
          updated += 1;
        }, { ttlMs: 3000, waitMs: 2000, pollMs: 20, now });
      } catch {
        // 访问计数是尽力而为，失败不影响对话
      }
    });
    return { updated };
  }

  async function get(userId, memoryId) {
    return loadOne(userId, memoryId);
  }

  async function stats(userId) {
    const keys = await repo.listKeys(memoryPrefix(userId), { limit: 2000 });
    const docs = await mapLimit(keys, 8, (key) => repo.getJSON(key, { tolerant: true }));
    const ts = now();
    const active = docs.filter((d) => d && d.isActive === true && Number(d.expiresAt ?? 0) > ts);
    return {
      totalFiles: keys.length,
      activeCount: active.length,
      inactiveCount: docs.filter((d) => d && d.isActive !== true).length,
      topTags: countTopTags(active),
    };
  }

  function countTopTags(docs) {
    const counter = new Map();
    for (const doc of docs) {
      for (const tag of doc.tags ?? []) counter.set(tag, (counter.get(tag) ?? 0) + 1);
    }
    return [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));
  }

  return {
    writeBatch,
    recall,
    touch,
    get,
    stats,
    enforceCapacity,
    deactivateExpired,
    hardDeleteInactive,
    loadActive,
  };
}

export function assertMemoryId(memoryId) {
  if (typeof memoryId !== 'string' || !/^[a-f0-9]{64}$/.test(memoryId)) {
    throw new AppError(ErrorCodes.BAD_REQUEST, 'memoryId 非法', 400);
  }
  return memoryId;
}
