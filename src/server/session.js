/**
 * 会话服务 —— 统一负责创建、续接、显式结束与超时回收。
 *
 * 状态机： active ──(显式结束)──▶ ended
 *          active ──(空闲超时/超最长存活/超最大轮数)──▶ expired
 * 两个终态都会触发「记忆提炼」并写回长期记忆。
 */

import { SessionRepo, ILinkRepo } from './repository.js';
import { randomToken, now } from './lib/util.js';

export const SessionState = {
  ACTIVE: 'active',
  ENDED: 'ended',
  EXPIRED: 'expired',
};

export class SessionService {
  constructor({ store, cfg, memoryEngine, summarizer, ilink, log } = {}) {
    this.store = store;
    this.cfg = cfg;
    this.memoryEngine = memoryEngine;
    this.summarizer = summarizer;
    this.ilink = ilink;
    this.log = log || (() => {});
  }

  #newSession({ userId, contextToken, sessionRef }) {
    const t = now();
    const ttl = Number(this.cfg.SESSION_TTL_SECONDS) || 1800;
    return {
      sessionId: `s_${t.toString(36)}${randomToken(10)}`,
      userId,
      state: SessionState.ACTIVE,
      createdAt: t,
      updatedAt: t,
      lastActiveAt: t,
      hardDeadline: t + (Number(this.cfg.SESSION_MAX_SECONDS) || 28800) * 1000,
      expiresAt: t + ttl * 1000,
      turn: 0,
      messages: [],
      rollingSummary: '',
      messageCount: 0,
      contextToken: contextToken || '',
      sessionRef: sessionRef || '',
      memoryInjectIds: [],
      memoryDigest: '',
      endReason: null,
      endedAt: 0,
      endedBy: '',
      lastMessageId: '',
      meta: {},
    };
  }

  isExpired(session, ts = now()) {
    if (!session) return true;
    if (session.state !== SessionState.ACTIVE) return true;
    if (session.expiresAt && session.expiresAt <= ts) return true;
    if (session.hardDeadline && session.hardDeadline <= ts) return true;
    return false;
  }

  /**
   * 解析出应当使用的会话。
   * @returns {Promise<{session:object, created:boolean, resumed:boolean, previousEnded:boolean}>}
   */
  async resolve({ userId, sessionId, contextToken, sessionRef, forceNew = false, query = '' }) {
    let session = null;
    let previousEnded = false;

    if (sessionId && !forceNew) {
      session = await SessionRepo.get(this.store, userId, sessionId);
      if (session && this.isExpired(session)) {
        previousEnded = true;
        await this.#retire(session, SessionState.EXPIRED, 'idle-timeout');
        session = null;
      }
    } else if (!forceNew) {
      const index = await SessionRepo.getIndex(this.store, userId);
      if (index.active) {
        const candidate = await SessionRepo.get(this.store, userId, index.active);
        if (candidate && !this.isExpired(candidate)) {
          session = candidate;
        } else if (candidate) {
          previousEnded = true;
          await this.#retire(candidate, SessionState.EXPIRED, 'idle-timeout');
        }
      }
    }

    let created = false;
    if (!session) {
      if (forceNew || this.cfg.SESSION_AUTO_CREATE !== false) {
        session = await this.create({ userId, contextToken, sessionRef, query });
        created = true;
      } else {
        return { session: null, created: false, resumed: false, previousEnded };
      }
    }

    if (contextToken) session.contextToken = contextToken;
    if (sessionRef) session.sessionRef = sessionRef;
    return { session, created, resumed: !created, previousEnded };
  }

  /** 创建新会话，并在此刻把历史记忆压缩摘要固化注入到会话里（整个会话生命周期内保持稳定）。 */
  async create({ userId, contextToken, sessionRef, query = '' }) {
    const session = this.#newSession({ userId, contextToken, sessionRef });
    if (this.cfg.MEMORY_INJECT_MAX !== 0 && this.summarizer) {
      const digest = await this.summarizer.buildMemoryDigest({ userId, query }).catch((e) => {
        this.log('warn', 'session:digest_failed', { userId, error: e.message });
        return { text: '', ids: [] };
      });
      session.memoryDigest = digest.text || '';
      session.memoryInjectIds = digest.ids || [];
      if (digest.ids?.length) {
        await this.memoryEngine.markHit(userId, digest.ids).catch(() => {});
      }
    }
    if (contextToken) await ILinkRepo.rememberContext(this.store, userId, contextToken);
    await this.persist(session);
    this.log('info', 'session:create', { userId, sessionId: session.sessionId, digestChars: session.memoryDigest.length });
    return session;
  }

  /** 续期并写回。 */
  async touch(session) {
    const t = now();
    session.lastActiveAt = t;
    session.updatedAt = t;
    session.expiresAt = t + (Number(this.cfg.SESSION_TTL_SECONDS) || 1800) * 1000;
    return this.persist(session);
  }

  async persist(session) {
    await SessionRepo.put(this.store, session.userId, session);
    if (session.state === SessionState.ACTIVE) {
      await SessionRepo.markActive(this.store, session.userId, session.sessionId, session.expiresAt);
    }
    return session;
  }

  /** 追加消息，并在超窗时滚动摘要。 */
  async append(session, ...messages) {
    for (const m of messages) {
      session.messages.push({ ...m, ts: m.ts || now() });
    }
    session.messageCount = session.messages.length;
    await this.#maybeRoll(session);
    return session;
  }

  async #maybeRoll(session) {
    const maxTurns = Number(this.cfg.SESSION_CONTEXT_TURNS) || 20;
    const keep = maxTurns * 3;
    const overflow = session.messages.filter((m) => m.role !== 'system').length - keep;
    if (overflow <= 0 || !this.summarizer) return;

    const droppable = session.messages.filter((m) => m.role !== 'system').slice(0, overflow);
    const nextSummary = await this.summarizer.rollSummary({
      previousSummary: session.rollingSummary,
      droppedMessages: droppable,
    }).catch(() => session.rollingSummary);
    session.rollingSummary = nextSummary || session.rollingSummary;
    const dropSet = new Set(droppable);
    session.messages = session.messages.filter((m) => !dropSet.has(m));
  }

  // ── 结束 ──────────────────────────────────────────────────────────────

  /** 标记会话需要结束（由工具调用触发，实际收尾在 finalize 中同步完成）。 */
  async requestEnd({ userId, sessionId, reason }) {
    if (!sessionId) return null;
    const session = await SessionRepo.get(this.store, userId, sessionId);
    if (!session || session.state !== SessionState.ACTIVE) return null;
    return this.endSession({ userId, sessionId, reason, by: 'model' });
  }

  /**
   * 结束会话：提炼记忆 → 落库 → 从登记表移除。
   * @returns {Promise<{session:object, memories:Array<object>}>}
   */
  async endSession({ userId, sessionId, reason = 'explicit', by = 'user' }) {
    const session = await SessionRepo.get(this.store, userId, sessionId);
    if (!session) return { session: null, memories: [] };
    if (session.state !== SessionState.ACTIVE) {
      return { session, memories: [] };
    }

    const memories = await this.extractIntoMemory(session);
    const t = now();
    session.state = SessionState.ENDED;
    session.endReason = reason;
    session.endedBy = by;
    session.endedAt = t;
    session.expiresAt = t;
    // 终态保留 24h 便于审计/排障
    await this.store.put(
      `${`sess:v1:${userId}:${sessionId}`}`,
      { ...session, messages: session.messages.slice(-20) },
      86400,
    );
    await SessionRepo.unmarkActive(this.store, userId, sessionId);
    this.log('info', 'session:end', { userId, sessionId, reason, by, turns: session.turn, memories: memories.length });
    return { session, memories };
  }

  /** 提炼并写入长期记忆（幂等：由 session.extractedAt 保护）。 */
  async extractIntoMemory(session) {
    if (session.extractedAt || this.cfg.MEMORY_EXTRACT_ENABLED === false) return [];
    session.extractedAt = now();
    const candidates = await this.summarizer.extractMemories(session).catch((e) => {
      this.log('warn', 'session:extract_failed', { error: e.message });
      return [];
    });
    const saved = await this.memoryEngine.writeBatch(session.userId, candidates, {
      source: 'extract',
      sessionId: session.sessionId,
    }).catch(() => []);
    return saved;
  }

  /** 内部态：走到终态但无需再提炼（已在提取流程内）。 */
  async #retire(session, state, reason) {
    const t = now();
    session.state = state;
    session.endReason = reason;
    session.endedAt = t;
    session.expiresAt = t;
    await this.extractIntoMemory(session).catch(() => {});
    await this.store.put(`sess:v1:${session.userId}:${session.sessionId}`, { ...session, messages: session.messages.slice(-20) }, 86400);
    await SessionRepo.unmarkActive(this.store, session.userId, session.sessionId);
  }

  /**
   * 超时回收：扫描全局登记表。
   * @returns {Promise<{scanned:number, expired:number, memories:number, details:Array}>}
   */
  async sweep(limit = 50) {
    const keys = await SessionRepo.dueForSweep(this.store, limit);
    let expired = 0;
    let memories = 0;
    const details = [];
    for (const key of keys) {
      const sep = key.indexOf('|');
      const userId = key.slice(0, sep);
      const sessionId = key.slice(sep + 1);
      const session = await SessionRepo.get(this.store, userId, sessionId);
      if (!session) {
        await SessionRepo.unmarkActive(this.store, userId, sessionId);
        continue;
      }
      const reason = session.hardDeadline && session.hardDeadline <= now() ? 'hard-deadline' : 'idle-timeout';
      const saved = await this.extractIntoMemory(session);
      session.state = SessionState.EXPIRED;
      session.endReason = reason;
      session.endedBy = 'system';
      session.endedAt = now();
      await this.store.put(
        `sess:v1:${session.userId}:${session.sessionId}`,
        { ...session, messages: session.messages.slice(-20) },
        86400,
      );
      await SessionRepo.unmarkActive(this.store, userId, sessionId);
      expired++;
      memories += saved.length;
      details.push({ userId, sessionId, reason, turns: session.turn, memories: saved.length });
    }
    if (expired) this.log('info', 'session:sweep', { expired, memories });
    return { scanned: keys.length, expired, memories, details };
  }

  async status(userId) {
    const index = await SessionRepo.getIndex(this.store, userId);
    const active = index.active ? await SessionRepo.get(this.store, userId, index.active) : null;
    return {
      activeSessionId: active?.sessionId || null,
      state: active ? (this.isExpired(active) ? SessionState.EXPIRED : active.state) : 'none',
      turn: active?.turn || 0,
      expiresAt: active?.expiresAt || 0,
      recent: index.recent || [],
    };
  }
}
