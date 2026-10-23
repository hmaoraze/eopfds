/**
 * 会话服务：单个会话对象的生命周期与并发控制。
 *
 * 存储形态（B1.2）：sessions/{userId}/{sessionId}.json —— 单文件整文档。
 * 这是本服务里唯一允许 read-modify-write 整文档的数据，原因是单会话的下游并发天然接近 1
 * （一个微信窗口一次只能说一句话）。代价是必须串行化，方案见下面的 beginTurn / completeTurn。
 *
 * 串行化选择：不用「整轮持锁」，改为 in-flight 标记（pendingTurn）。
 * 理由：整轮持锁意味着把 DeepSeek 的 10~40 秒网络耗时包在锁里，函数执行时间会被锁租约绑架，
 * 且并发请求只能排队等到超时。pendingTurn 只在「写用户消息」和「写助手回复」两个短临界区内生效，
 * 中途不占锁，同时又能拒绝真正会撕裂上下文的并发轮次（409 SESSION_BUSY）。
 */

import { AppError, ErrorCodes } from './errors.js';
import { randomToken } from './crypto-utils.js';
import { withLock } from './lock.js';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export const SESSION_STATUS = Object.freeze({
  ACTIVE: 'active',
  ENDED: 'ended',
  EXPIRED: 'expired',
});

export const sessionKey = (userId, sessionId) => `sessions/${userId}/${sessionId}.json`;
export const sessionLockKey = (userId, sessionId) => `locks/session/${userId}/${sessionId}.json`;
export const sessionPrefix = (userId) => `sessions/${userId}/`;
export const pointerKey = (userId) => `cursors/session/${userId}.json`;

export function assertUserId(userId) {
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    throw new AppError(ErrorCodes.BAD_REQUEST, 'userId 非法（允许字母、数字、下划线、连字符，1~64 位）', 400, {
      field: 'userId',
    });
  }
  return userId;
}

export function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new AppError(ErrorCodes.BAD_REQUEST, 'sessionId 非法（允许字母、数字、下划线、连字符，6~64 位）', 400, {
      field: 'sessionId',
    });
  }
  return sessionId;
}

export function newSessionId() {
  return `s_${Date.now().toString(36)}${randomToken(6)}`;
}

export function createSessionService({ repo, cfg, clock = { now: () => Date.now() } }) {
  const now = () => clock.now();

  function isExpired(doc, at = now()) {
    if (!doc || doc.status !== SESSION_STATUS.ACTIVE) return false;
    return at - Number(doc.lastActiveAt ?? 0) > cfg.sessionTimeoutMs;
  }

  function expiresAtOf(doc) {
    return Number(doc?.lastActiveAt ?? 0) + cfg.sessionTimeoutMs;
  }

  async function get(userId, sessionId) {
    return repo.getJSON(sessionKey(userId, sessionId), { tolerant: true });
  }

  async function create({
    userId,
    sessionId = newSessionId(),
    source = 'api',
    metadata = {},
    memorySummary = '',
    recallMemoryIds = [],
    systemSnapshot = null,
  }) {
    assertUserId(userId);
    assertSessionId(sessionId);
    const ts = now();
    const doc = {
      schemaVersion: 1,
      sessionId,
      userId,
      createdAt: ts,
      lastActiveAt: ts,
      status: SESSION_STATUS.ACTIVE,
      endedAt: null,
      endReason: null,
      messages: [],
      turnCount: 0,
      version: 1,
      source,
      metadata,
      // 摘要创建时生成一次并缓存：同一会话内不随轮次抖动（B5.5）
      memorySummary,
      memorySummaryItemCount: recallMemoryIds.length,
      recallMemoryIds,
      systemSnapshot,
      pendingTurn: null,
      distilledAt: null,
      distilledMemoryCount: null,
    };
    const created = await repo.setJSONIfAbsent(sessionKey(userId, sessionId), doc);
    if (!created) {
      throw new AppError(ErrorCodes.SESSION_EXISTS, '会话已存在', 409, { sessionId });
    }
    await setPointer(userId, sessionId);
    return doc;
  }

  /** 超时惰性结算：任何读到该会话的路径都会先过这一关，无需后台定时器也能收敛状态。 */
  async function settleExpiry(userId, doc) {
    if (!doc) return { doc, expiredNow: false };
    if (!isExpired(doc)) return { doc, expiredNow: false };
    const ts = now();
    const next = {
      ...doc,
      status: SESSION_STATUS.EXPIRED,
      endedAt: ts,
      endReason: 'timeout',
      pendingTurn: null,
      version: Number(doc.version ?? 0) + 1,
    };
    await repo.setJSON(sessionKey(userId, doc.sessionId), next);
    return { doc: next, expiredNow: true };
  }

  /**
   * 进入一轮对话：校验状态、抢占 in-flight 标记、写入用户消息。
   * 临界区内只有两次 Blob 操作，Worker 不会长时间持锁。
   */
  async function beginTurn({ userId, sessionId, text }) {
    assertUserId(userId);
    assertSessionId(sessionId);

    return withLock(repo, sessionLockKey(userId, sessionId), async () => {
      const raw = await get(userId, sessionId);
      if (!raw) throw new AppError(ErrorCodes.SESSION_NOT_FOUND, '会话不存在', 404, { sessionId });

      const { doc, expiredNow } = await settleExpiry(userId, raw);
      if (expiredNow) {
        return { expired: true, doc, token: null };
      }
      if (doc.status === SESSION_STATUS.ENDED) {
        throw new AppError(ErrorCodes.SESSION_ENDED, '会话已结束，请创建新会话', 409, {
          sessionId,
          endedAt: doc.endedAt,
        });
      }

      const ts = now();
      if (doc.pendingTurn && ts - Number(doc.pendingTurn.startedAt ?? 0) < cfg.sessionBusyTtlMs) {
        throw new AppError(ErrorCodes.SESSION_BUSY, '该会话上一轮仍在处理中', 409, {
          sessionId,
          retryAfterMs: Math.max(500, cfg.sessionBusyTtlMs - (ts - Number(doc.pendingTurn.startedAt ?? 0))),
        });
      }

      const token = randomToken(10);
      const next = {
        ...doc,
        messages: [...doc.messages, { role: 'user', content: text, at: ts }],
        pendingTurn: { token, startedAt: ts },
        lastActiveAt: ts,
        version: Number(doc.version ?? 0) + 1,
      };
      await repo.setJSON(sessionKey(userId, sessionId), next);
      return { expired: false, doc: next, token };
    }, { ttlMs: 8000, waitMs: 8000, pollMs: 30, now });
  }

  /** 提交一轮结果：追加助手侧消息（含 tool 交换），释放 in-flight 标记。 */
  async function completeTurn({ userId, sessionId, token, assistantMessages = [] }) {
    return withLock(repo, sessionLockKey(userId, sessionId), async () => {
      const doc = await get(userId, sessionId);
      if (!doc) throw new AppError(ErrorCodes.SESSION_NOT_FOUND, '会话不存在', 404, { sessionId });

      const ts = now();
      const stale = doc.pendingTurn?.token !== token;
      const appended = assistantMessages
        .filter((m) => m && typeof m === 'object')
        .map((m) => ({ ...m, at: ts }));

      const next = {
        ...doc,
        messages: [...doc.messages, ...appended],
        pendingTurn: null,
        turnCount: Number(doc.turnCount ?? 0) + 1,
        lastActiveAt: ts,
        version: Number(doc.version ?? 0) + 1,
      };
      await repo.setJSON(sessionKey(userId, sessionId), next);
      return { doc: next, stale };
    }, { ttlMs: 8000, waitMs: 8000, pollMs: 30, now });
  }

  /** 放弃一轮（上游失败）：清标记但不写助手消息，用户消息保留以便重试语义清晰。 */
  async function abortTurn({ userId, sessionId, token }) {
    return withLock(repo, sessionLockKey(userId, sessionId), async () => {
      const doc = await get(userId, sessionId);
      if (!doc) return null;
      if (doc.pendingTurn?.token !== token) return doc;
      const next = { ...doc, pendingTurn: null, version: Number(doc.version ?? 0) + 1 };
      await repo.setJSON(sessionKey(userId, sessionId), next);
      return next;
    }, { ttlMs: 8000, waitMs: 8000, pollMs: 30, now });
  }

  /**
   * 显式结束。幂等：重复调用返回 alreadyEnded=true，且不重复触发提炼
   * （shouldDistill 由 distilledAt 决定，不是由调用次数决定）。
   */
  async function end({ userId, sessionId, reason = 'explicit' }) {
    return withLock(repo, sessionLockKey(userId, sessionId), async () => {
      const doc = await get(userId, sessionId);
      if (!doc) throw new AppError(ErrorCodes.SESSION_NOT_FOUND, '会话不存在', 404, { sessionId });

      if (doc.status !== SESSION_STATUS.ACTIVE) {
        return { doc, alreadyInactive: true, shouldDistill: false };
      }

      const ts = now();
      const next = {
        ...doc,
        status: SESSION_STATUS.ENDED,
        endedAt: ts,
        endReason: reason,
        pendingTurn: null,
        version: Number(doc.version ?? 0) + 1,
      };
      await repo.setJSON(sessionKey(userId, sessionId), next);
      return { doc: next, alreadyInactive: false, shouldDistill: !next.distilledAt };
    }, { ttlMs: 8000, waitMs: 8000, pollMs: 30, now });
  }

  /**
   * 提炼闸门。
   *
   * 不用 distilledAt 当闸门，而是用带租约的 distillationStartedAt：
   * Node Functions 的 context 没有 waitUntil，异步任务可能随函数返回被回收，
   * 此时若已经把 distilledAt 写成终态，这次提炼就永久丢失了。
   * 改成「开始标记 + 租约」后：进程被杀 → 标记过期 → 下一次维护任务自动重试。
   * 成功时 releaseDistillation 才写 distilledAt（终态，永不再跑）。
   */
  async function claimDistillation({ userId, sessionId }) {
    return withLock(repo, sessionLockKey(userId, sessionId), async () => {
      const doc = await get(userId, sessionId);
      if (!doc) return { claimed: false, doc: null, reason: 'not_found' };
      if (doc.distilledAt) return { claimed: false, doc, reason: 'already_distilled' };
      if (!Array.isArray(doc.messages) || doc.messages.length === 0) {
        return { claimed: false, doc, reason: 'empty_session' };
      }

      const ts = now();
      const startedAt = Number(doc.distillationStartedAt ?? 0);
      if (startedAt > 0 && ts - startedAt < cfg.distillLockTtlMs) {
        return { claimed: false, doc, reason: 'in_progress' };
      }

      const next = {
        ...doc,
        distillationStartedAt: ts,
        distillationAttempts: Number(doc.distillationAttempts ?? 0) + 1,
        version: Number(doc.version ?? 0) + 1,
      };
      await repo.setJSON(sessionKey(userId, sessionId), next);
      return { claimed: true, doc: next };
    }, { ttlMs: 8000, waitMs: 8000, pollMs: 30, now });
  }

  /**
   * 释放提炼闸门。
   * 成功：写 distilledAt（终态）+ 记忆条数；失败：清开始标记（等租约过期后重试）+ 记录原因。
   */
  async function releaseDistillation({ userId, sessionId, count, error }) {
    const doc = await get(userId, sessionId);
    if (!doc) return null;
    const ts = now();
    const failed = Boolean(error);
    const next = {
      ...doc,
      distilledAt: failed ? (doc.distilledAt ?? null) : ts,
      distillationStartedAt: null,
      distillationFailedAt: failed ? ts : (doc.distillationFailedAt ?? null),
      distilledMemoryCount: failed ? (doc.distilledMemoryCount ?? null) : (count ?? null),
      distillationError: failed ? String(error).slice(0, 200) : null,
      version: Number(doc.version ?? 0) + 1,
    };
    await repo.setJSON(sessionKey(userId, sessionId), next);
    return next;
  }

  async function listByUser(userId, { limit = 100 } = {}) {
    const keys = await repo.listKeys(sessionPrefix(userId), { limit });
    const docs = await Promise.all(keys.map((key) => repo.getJSON(key, { tolerant: true })));
    return docs.filter(Boolean);
  }

  async function listAllKeys({ limit = 1000 } = {}) {
    return repo.listKeys('sessions/', { limit });
  }

  async function setPointer(userId, sessionId) {
    await repo.setJSON(pointerKey(userId), { sessionId, updatedAt: now() });
  }

  async function getPointer(userId) {
    return repo.getJSON(pointerKey(userId), { tolerant: true });
  }

  /** 取当前可续接的会话 id；已结束/已超时返回 null，由调用方决定是否新建。 */
  async function resolveResumable(userId) {
    const pointer = await getPointer(userId);
    if (!pointer?.sessionId) return null;
    const doc = await get(userId, pointer.sessionId);
    if (!doc) return null;
    if (doc.status !== SESSION_STATUS.ACTIVE) return null;
    if (isExpired(doc)) {
      await settleExpiry(userId, doc);
      return null;
    }
    return doc;
  }

  return {
    isExpired,
    expiresAtOf,
    get,
    create,
    settleExpiry,
    beginTurn,
    completeTurn,
    abortTurn,
    end,
    claimDistillation,
    releaseDistillation,
    listByUser,
    listAllKeys,
    setPointer,
    getPointer,
    resolveResumable,
  };
}
