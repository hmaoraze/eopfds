/**
 * 记忆引擎：指纹去重 → 相似度合并 → 多维打分 → 容量裁剪 → 过期淘汰。
 *
 * 打分：score = Σwᵢ·xᵢ，其中
 *   importance  归一化的 1..5 重要度
 *   recency     0.5^(ageHours / halfLifeHours)      —— 指数衰减，可配半衰期
 *   frequency   log(1+hits) / log(1+maxHits+1)      —— 被命中次数（对数压缩）
 *   relevance   记忆内容与当前输入的二元组 Jaccard 相关度（无查询时该项权重并入其他项）
 * 裁剪：先清过期，再按 score 升序淘汰；重要度 ≥ MEMORY_PIN_IMPORTANCE 且在有效期内者暂不淘汰。
 */

import { MemoryRepo } from './repository.js';
import { now, shortHash, truncate } from './lib/util.js';

const HOUR = 3600_000;

// ── 文本处理 ───────────────────────────────────────────────────────────

/** 归一化：小写、去标点空白、全角转半角。用于指纹与相似度比较。 */
export function normalizeContent(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .trim();
}

/** 字符二元组集合（中英文通用）。 */
export function bigrams(normalized) {
  const set = new Set();
  if (normalized.length < 2) {
    if (normalized) set.add(normalized);
    return set;
  }
  for (let i = 0; i < normalized.length - 1; i++) set.add(normalized.slice(i, i + 2));
  return set;
}

export function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const v of small) if (large.has(v)) inter++;
  return inter / (setA.size + setB.size - inter);
}

export function similarity(textA, textB) {
  return jaccard(bigrams(normalizeContent(textA)), bigrams(normalizeContent(textB)));
}

// ── 引擎 ───────────────────────────────────────────────────────────────

export class MemoryEngine {
  constructor(store, cfg, { log } = {}) {
    this.store = store;
    this.cfg = cfg;
    this.log = log || (() => {});
  }

  async load(userId) {
    const doc = await MemoryRepo.get(this.store, userId);
    if (!doc.items) doc.items = [];
    return doc;
  }

  async save(userId, doc) {
    doc.userId = userId;
    doc.updatedAt = now();
    await MemoryRepo.put(this.store, userId, doc);
    await MemoryRepo.dropDigest(this.store, userId); // 摘要失效
    return doc;
  }

  /** 计算单个 item 的综合得分（0..1）。 */
  scoreItem(item, { maxHits = 1, weights, halfLifeHours, queryVec = null, nowTs = now() } = {}) {
    const w = weights || this.cfg.MEMORY_WEIGHTS_NORMALIZED;
    const halfLife = Number(halfLifeHours || this.cfg.MEMORY_HALF_LIFE_HOURS) || 72;
    const ageHours = Math.max(0, (nowTs - (item.updatedAt || item.createdAt || nowTs)) / HOUR);
    const recency = Math.pow(0.5, ageHours / halfLife);
    const importance = Math.min(1, Math.max(0, (Number(item.importance) || 3) / 5));
    const frequency = Math.log(1 + (item.hits || 0)) / Math.log(1 + Math.max(1, maxHits) + 1);

    let relevance = 0;
    let hasRelevance = false;
    if (queryVec) {
      relevance = jaccard(queryVec, item.__vec || bigrams(normalizeContent(item.content)));
      hasRelevance = true;
    }

    const parts = [
      { w: w.importance, x: importance },
      { w: w.recency, x: recency },
      { w: w.frequency, x: frequency },
    ];
    if (hasRelevance) parts.push({ w: w.relevance, x: relevance });

    const totalW = parts.reduce((s, p) => s + p.w, 0);
    if (totalW <= 0) return importance;
    return parts.reduce((s, p) => s + (p.w / totalW) * p.x, 0);
  }

  /** 附加速算缓存，避免重复构造二元组。 */
  #annotate(items, nowTs) {
    for (const it of items) {
      it.__vec = bigrams(normalizeContent(it.content));
      it.__ageHours = (nowTs - (it.updatedAt || it.createdAt || nowTs)) / HOUR;
    }
    return items;
  }

  /**
   * 写入（去重 + 合并）。返回最终生效的 item。
   * @param {object} input { userId, content, category, importance, tags, ttlDays, source, sessionId }
   */
  async write(input) {
    const { userId, content } = input;
    const clean = String(content || '').trim();
    if (!clean) throw new Error('记忆内容不能为空');

    const doc = await this.load(userId);
    const nowTs = now();
    const fingerprint = await shortHash(normalizeContent(clean), 20);
    const incomingVec = bigrams(normalizeContent(clean));
    const importance = Math.min(5, Math.max(1, Number(input.importance) || 3));
    const ttlDays = Number(input.ttlDays) > 0 ? Number(input.ttlDays) : Number(this.cfg.MEMORY_TTL_DAYS);

    // 1) 指纹命中 → 视为重复
    const same = doc.items.find((it) => it.fingerprint === fingerprint);
    if (same) {
      same.hits = (same.hits || 0) + 1;
      same.updatedAt = nowTs;
      same.importance = Math.max(same.importance || 3, importance);
      same.tags = unionTags(same.tags, input.tags);
      if (ttlDays > 0) same.expiresAt = nowTs + ttlDays * 86400_000;
      same.lastSessionId = input.sessionId || same.lastSessionId;
      await this.save(userId, this.evict(doc, { nowTs }));
      return { ...same, deduped: true };
    }

    // 2) 相似度 ≥ 阈值 → 合并
    const threshold = Number(this.cfg.MEMORY_SIMILARITY_MERGE) || 0.82;
    let best = null;
    let bestSim = 0;
    for (const it of doc.items) {
      if (!it.content) continue;
      const sim = jaccard(incomingVec, bigrams(normalizeContent(it.content)));
      if (sim >= threshold && sim > bestSim) {
        best = it;
        bestSim = sim;
      }
    }
    if (best) {
      best.hits = (best.hits || 0) + 1;
      best.updatedAt = nowTs;
      best.mergedCount = (best.mergedCount || 0) + 1;
      best.tags = unionTags(best.tags, input.tags);
      best.expiresAt = ttlDays > 0 ? nowTs + ttlDays * 86400_000 : 0;
      best.lastSessionId = input.sessionId || best.lastSessionId;
      // 更重要或更具体的表述优先
      if (importance >= (best.importance || 0) && clean.length > String(best.content || '').length) {
        best.previousContent = best.content;
        best.content = clean;
      }
      best.importance = Math.max(best.importance || 3, importance);
      best.source = input.source || best.source;
      await this.save(userId, this.evict(doc, { nowTs }));
      return { ...best, mergedWith: true, similarity: Number(bestSim.toFixed(3)) };
    }

    // 3) 新增
    const item = {
      id: await shortHash(`${userId}:${fingerprint}:${nowTs}:${Math.random()}`, 16),
      content: clean,
      category: input.category || 'fact',
      importance,
      tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 8) : [],
      createdAt: nowTs,
      updatedAt: nowTs,
      expiresAt: ttlDays > 0 ? nowTs + ttlDays * 86400_000 : 0,
      hits: 0,
      mergedCount: 0,
      source: input.source || 'unknown',
      lastSessionId: input.sessionId || '',
      fingerprint,
    };
    doc.items.push(item);
    await this.save(userId, this.evict(doc, { nowTs }));
    return item;
  }

  /** 批量写入（会话结束提炼用），自动去重合并。 */
  async writeBatch(userId, list, { source = 'extract', sessionId = '' } = {}) {
    if (!Array.isArray(list) || !list.length) return [];
    const limit = Math.min(Number(this.cfg.MEMORY_EXTRACT_MAX) || 8, list.length);
    const results = [];
    for (const raw of list.slice(0, limit)) {
      if (!raw || !String(raw.content || '').trim()) continue;
      try {
        results.push(await this.write({
          userId,
          content: String(raw.content).trim(),
          category: raw.category || 'fact',
          importance: raw.importance ?? 3,
          tags: Array.isArray(raw.tags) ? raw.tags : [],
          ttlDays: raw.ttlDays,
          source,
          sessionId,
        }));
      } catch { /* 单条失败不影响整体 */ }
    }
    return results;
  }

  /**
   * 排序查询：带 query 时纳入相关度权重。
   * @returns {Promise<Array<object>>} 已注入 score 字段
   */
  async query({ userId, query = '', limit = 20, nowTs = now() }) {
    const doc = await this.load(userId);
    const fresh = this.dropExpired(doc, nowTs);
    if (fresh) await this.save(userId, doc);

    const items = this.#annotate(doc.items, nowTs);
    const maxHits = items.reduce((m, it) => Math.max(m, it.hits || 0), 1);
    const queryVec = query ? bigrams(normalizeContent(query)) : null;

    const scored = items.map((it) => ({
      ...it,
      score: this.scoreItem(it, { maxHits, queryVec, nowTs }),
      relevance: queryVec ? jaccard(queryVec, it.__vec) : 0,
    }));
    scored.sort((a, b) => b.score - a.score || b.importance - a.importance || b.updatedAt - a.updatedAt);
    return scored.slice(0, limit).map(stripInternal);
  }

  /** 命中计数 +1（被注入到上下文或被工具检索到）。 */
  async markHit(userId, ids) {
    if (!ids?.length) return;
    const set = new Set(ids);
    const doc = await this.load(userId);
    let dirty = false;
    for (const it of doc.items) {
      if (set.has(it.id)) {
        it.hits = (it.hits || 0) + 1;
        it.hitAt = now();
        dirty = true;
      }
    }
    if (dirty) await MemoryRepo.put(this.store, userId, { ...doc, updatedAt: now() });
  }

  /**
   * 生成用于注入上下文的候选记忆。
   * @returns {Promise<{items:Array, totalChars:number}>}
   */
  async selectForInjection({ userId, query = '', limit, maxChars }) {
    const take = limit ?? (Number(this.cfg.MEMORY_INJECT_MAX) || 12);
    const cap = maxChars ?? (Number(this.cfg.MEMORY_INJECT_MAX_CHARS) || 1800);
    const ranked = await this.query({ userId, query, limit: Math.max(take * 3, take) });
    const items = [];
    let total = 0;
    for (const it of ranked) {
      if (items.length >= take) break;
      const line = formatMemoryLine(it);
      if (total + line.length > cap) break;
      items.push(it);
      total += line.length;
    }
    return { items, totalChars: total };
  }

  /** 过期清理 / 容量裁剪（原地修改 doc）。 */
  evict(doc, { nowTs = now() } = {}) {
    const dropped = this.dropExpired(doc, nowTs);
    const maxItems = Number(this.cfg.MEMORY_MAX_ITEMS) || 200;
    const pin = Number(this.cfg.MEMORY_PIN_IMPORTANCE) || 5;
    let removed = 0;

    if (doc.items.length > maxItems) {
      const items = this.#annotate(doc.items, nowTs);
      const maxHits = items.reduce((m, it) => Math.max(m, it.hits || 0), 1);
      const scored = items.map((it) => ({ it, s: this.scoreItem(it, { maxHits, nowTs }) }));
      scored.sort((a, b) => a.s - b.s);
      const excess = doc.items.length - maxItems;
      const victims = new Set();
      for (const { it, s } of scored) {
        if (victims.size >= excess) break;
        if ((it.importance || 0) >= pin && (!it.expiresAt || it.expiresAt > nowTs)) continue;
        victims.add(it.id);
      }
      // 若全部被 pin 而无法释放，退化为按得分强制淘汰
      if (victims.size < excess) {
        for (const { it } of scored) {
          if (victims.size >= excess) break;
          victims.add(it.id);
        }
      }
      doc.items = doc.items.filter((it) => !victims.has(it.id));
      removed = victims.size;
    }
    if (dropped || removed) {
      this.log('info', 'memory:evict', { userId: doc.userId, expired: dropped, evicted: removed, remain: doc.items.length });
    }
    return doc;
  }

  /** @returns {number} 清除条数 */
  dropExpired(doc, nowTs = now()) {
    const before = doc.items.length;
    doc.items = doc.items.filter((it) => !it.expiresAt || it.expiresAt > nowTs);
    return before - doc.items.length;
  }

  async stats(userId) {
    const doc = await this.load(userId);
    const nowTs = now();
    const expired = doc.items.filter((it) => it.expiresAt && it.expiresAt <= nowTs).length;
    const byCategory = {};
    const byImportance = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const it of doc.items) {
      byCategory[it.category || 'fact'] = (byCategory[it.category || 'fact'] || 0) + 1;
      byImportance[Math.min(5, Math.max(1, it.importance || 3))]++;
    }
    const chars = doc.items.reduce((s, it) => s + String(it.content || '').length, 0);
    return {
      total: doc.items.length,
      expiredPending: expired,
      chars,
      limit: Number(this.cfg.MEMORY_MAX_ITEMS) || 200,
      byCategory,
      byImportance,
      oldest: doc.items.reduce((m, it) => Math.min(m, it.createdAt || Infinity), Infinity),
    };
  }

  async purge(userId) {
    await MemoryRepo.put(this.store, userId, { userId, items: [], updatedAt: now() });
    await MemoryRepo.dropDigest(this.store, userId);
  }

  async remove(userId, memoryId) {
    const doc = await this.load(userId);
    const before = doc.items.length;
    doc.items = doc.items.filter((it) => it.id !== memoryId);
    await this.save(userId, doc);
    return before !== doc.items.length;
  }
}

function unionTags(a, b) {
  const set = new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].map(String).filter(Boolean));
  return [...set].slice(0, 10);
}

function stripInternal(it) {
  const { __vec, __ageHours, ...rest } = it;
  return rest;
}

export function formatMemoryLine(it) {
  const tagPart = it.tags?.length ? `（${it.tags.slice(0, 3).join('、')}）` : '';
  const impPart = it.importance >= 5 ? ' [重要]' : '';
  return `- ${truncate(it.content, 160)}${tagPart}${impPart}`;
}
