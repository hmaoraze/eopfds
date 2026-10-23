/**
 * 键空间与领域仓储。
 *
 * 键前缀统一带版本号 v1，便于未来平滑迁移：
 *
 *   cfg:v1:overrides          管理端写入的配置覆盖值
 *   cfg:v1:setup              初始化状态（是否已注册首个 Passkey）
 *   sess:v1:{uid}:{sid}       会话记录
 *   sidx:v1:{uid}             用户会话索引（活跃会话 + 最近列表）
 *   sw:v1:active              全局活跃会话登记表 { "uid|sid": expiresAt }（用于超时回收）
 *   mem:v1:{uid}              用户长期记忆文档
 *   msum:v1:{uid}             记忆压缩摘要缓存（下次开新会话时可复用）
 *   pk:v1:index               Passkey 凭据 ID 列表
 *   pk:v1:{credentialId}      Passkey 凭据明细（含公钥 JWK/JWK-thumbprint、签名计数器）
 *   wa:v1:ch:{id}             WebAuthn 挑战（短期）
 *   adm:v1:s:{tokenId}        管理端会话
 *   sl:v1:{jti}               临时安全链接状态（一次性）
 *   ilk:v1:cursor             iLink getupdates 游标
 *   ilk:v1:ctx:{uid}          用户最新 context_token 缓存
 *   ilk:v1:ticket:{uid}       typing_ticket 缓存（约 24h）
 *   dd:v1:{messageId}         消息去重（短期）
 *   aud:v1:{ts}:{rand}        管理端审计日志
 *   rl:v1:{scope}:{bucket}:{k} 限流计数
 */

import { randomToken, now } from './lib/util.js';

const V = 'v1';
export const K = {
  CONFIG_OVERRIDES: `cfg:${V}:overrides`,
  SETUP: `cfg:${V}:setup`,
  session: (uid, sid) => `sess:${V}:${uid}:${sid}`,
  sessionIndex: (uid) => `sidx:${V}:${uid}`,
  SWEEP_REGISTRY: `sw:${V}:active`,
  memory: (uid) => `mem:${V}:${uid}`,
  memoryDigest: (uid) => `msum:${V}:${uid}`,
  PASSKEY_INDEX: `pk:${V}:index`,
  passkey: (credId) => `pk:${V}:${credId}`,
  challenge: (id) => `wa:${V}:ch:${id}`,
  adminSession: (tokenId) => `adm:${V}:s:${tokenId}`,
  secureLink: (jti) => `sl:${V}:${jti}`,
  ILINK_CURSOR: `ilk:${V}:cursor`,
  ilinkContext: (uid) => `ilk:${V}:ctx:${uid}`,
  ilinkTicket: (uid) => `ilk:${V}:ticket:${uid}`,
  dedupe: (messageId) => `dd:${V}:${messageId}`,
  audit: () => `aud:${V}:${now()}:${randomToken(6)}`,
  auditIndex: `aud:${V}:index`,
  rate: (scope, bucket, k) => `rl:${V}:${scope}:${bucket}:${k}`,
};

const SWEEP_REGISTRY_MAX = 5000;

// ── 通用读写 ───────────────────────────────────────────────────────────

export async function getJson(store, key, fallback = null) {
  const v = await store.get(key);
  return v === undefined || v === null ? fallback : v;
}

export async function putJson(store, key, value, ttl) {
  await store.put(key, value, ttl);
  return value;
}

/** 读取-修改-写回（乐观锁，最多重试 n 次）。 */
export async function mutate(store, key, mutator, { fallback, ttl, retries = 2 } = {}) {
  for (let i = 0; i <= retries; i++) {
    const current = (await store.get(key)) ?? fallback;
    const next = await mutator(current === null ? undefined : current);
    if (next === undefined) return current;
    await store.put(key, next, ttl);
    return next;
  }
  return undefined;
}

// ── 配置 ───────────────────────────────────────────────────────────────

export const ConfigRepo = {
  getOverrides: (store) => getJson(store, K.CONFIG_OVERRIDES, {}),
  setOverrides: (store, overrides) => putJson(store, K.CONFIG_OVERRIDES, overrides),
  getSetup: (store) => getJson(store, K.SETUP, { initialized: false, initializedAt: 0 }),
  setSetup: (store, setup) => putJson(store, K.SETUP, setup),
};

// ── 会话 ───────────────────────────────────────────────────────────────

export const SessionRepo = {
  get: (store, uid, sid) => getJson(store, K.session(uid, sid)),

  async put(store, uid, session, graceSeconds = 86400) {
    const ttl = Math.ceil((session.expiresAt - now()) / 1000) + graceSeconds;
    await store.put(K.session(uid, session.sessionId), session, Math.max(ttl, 60));
    return session;
  },

  async putBySid(store, uid, sid, patch) {
    const cur = (await store.get(K.session(uid, sid))) || {};
    const merged = { ...cur, ...patch };
    await store.put(K.session(uid, sid), merged, patch.__ttl || undefined);
    return merged;
  },

  getIndex: (store, uid) => getJson(store, K.sessionIndex(uid), { active: null, recent: [] }),

  async putIndex(store, uid, index) {
    await store.put(K.sessionIndex(uid), index);
    return index;
  },

  async markActive(store, uid, sid, expiresAt) {
    await mutate(store, K.sessionIndex(uid), (idx = {}) => ({
      active: sid,
      recent: [sid, ...(idx.recent || []).filter((s) => s !== sid)].slice(0, 20),
    }), { fallback: { active: sid, recent: [sid] } });

    await mutate(store, K.SWEEP_REGISTRY, (reg = {}) => {
      const next = { ...reg, [`${uid}|${sid}`]: expiresAt };
      const keys = Object.keys(next);
      if (keys.length > SWEEP_REGISTRY_MAX) {
        keys.sort((a, b) => next[a] - next[b]);
        for (const k of keys.slice(0, keys.length - SWEEP_REGISTRY_MAX)) delete next[k];
      }
      return next;
    }, { fallback: { [`${uid}|${sid}`]: expiresAt } });
  },

  async unmarkActive(store, uid, sid) {
    await mutate(store, K.sessionIndex(uid), (idx = {}) => ({
      active: idx.active === sid ? null : idx.active,
      recent: idx.recent || [],
    }), { fallback: { active: null, recent: [] } });

    await mutate(store, K.SWEEP_REGISTRY, (reg = {}) => {
      if (!reg) return undefined;
      delete reg[`${uid}|${sid}`];
      return reg;
    }, { fallback: {} });
  },

  /** 返回已超时的活跃会话键列表。 */
  async dueForSweep(store, limit = 100) {
    const reg = (await store.get(K.SWEEP_REGISTRY)) || {};
    const t = now();
    return Object.entries(reg)
      .filter(([, exp]) => Number(exp) <= t)
      .slice(0, limit)
      .map(([key]) => key);
  },
};

// ── 记忆 ───────────────────────────────────────────────────────────────

export const MemoryRepo = {
  get: (store, uid) => getJson(store, K.memory(uid), { userId: uid, items: [], updatedAt: 0 }),
  put: (store, uid, doc) => putJson(store, K.memory(uid), doc),

  getDigest: (store, uid) => getJson(store, K.memoryDigest(uid), null),
  putDigest: (store, uid, digest, ttlSeconds = 3600) =>
    putJson(store, K.memoryDigest(uid), digest, ttlSeconds),
  dropDigest: (store, uid) => store.delete(K.memoryDigest(uid)),
};

// ── Passkey ────────────────────────────────────────────────────────────

export const PasskeyRepo = {
  async list(store) {
    const ids = (await store.get(K.PASSKEY_INDEX)) || [];
    const out = [];
    for (const id of ids) {
      const cred = await store.get(K.passkey(id));
      if (cred && !cred.revoked) out.push(cred);
    }
    return out;
  },

  async add(store, credential) {
    await store.put(K.passkey(credential.id), credential);
    await mutate(store, K.PASSKEY_INDEX, (ids = []) => (ids.includes(credential.id) ? ids : [...ids, credential.id]), { fallback: [credential.id] });
    return credential;
  },

  async find(store, credentialId) {
    return store.get(K.passkey(credentialId));
  },

  async update(store, credentialId, patch) {
    const cur = await store.get(K.passkey(credentialId));
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await store.put(K.passkey(credentialId), next);
    return next;
  },

  async remove(store, credentialId) {
    await store.delete(K.passkey(credentialId));
    await mutate(store, K.PASSKEY_INDEX, (ids = []) => ids.filter((i) => i !== credentialId), { fallback: [] });
  },

  async clear(store) {
    const ids = (await store.get(K.PASSKEY_INDEX)) || [];
    for (const id of ids) await store.delete(K.passkey(id));
    await store.put(K.PASSKEY_INDEX, []);
  },
};

// ── 管理端 ─────────────────────────────────────────────────────────────

export const AdminRepo = {
  putSession: (store, tokenId, data, ttl) => store.put(K.adminSession(tokenId), data, ttl),
  getSession: (store, tokenId) => store.get(K.adminSession(tokenId)),
  dropSession: (store, tokenId) => store.delete(K.adminSession(tokenId)),

  putLink: (store, jti, data, ttl) => store.put(K.secureLink(jti), data, ttl),
  getLink: (store, jti) => store.get(K.secureLink(jti)),
  patchLink: async (store, jti, patch) => {
    const cur = await store.get(K.secureLink(jti));
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await store.put(K.secureLink(jti), next, Math.max(1, Math.ceil((next.expiresAt - now()) / 1000)));
    return next;
  },
  dropLink: (store, jti) => store.delete(K.secureLink(jti)),

  putChallenge: (store, id, data, ttl = 120) => store.put(K.challenge(id), data, ttl),
  takeChallenge: async (store, id) => {
    const data = await store.get(K.challenge(id));
    if (data) await store.delete(K.challenge(id));
    return data;
  },

  async audit(store, entry, keep = 200) {
    const key = K.audit();
    await store.put(key, { ...entry, ts: now() }, 90 * 86400);
    await mutate(store, K.auditIndex, (keys = []) => {
      const next = [...keys, key];
      return next.length > keep ? next.slice(next.length - keep) : next;
    }, { fallback: [key] });
  },

  async recentAudit(store, limit = 50) {
    const keys = (await store.get(K.auditIndex)) || [];
    const out = [];
    for (const k of keys.slice(-limit)) {
      const e = await store.get(k);
      if (e) out.push(e);
    }
    return out.reverse();
  },
};

// ── iLink ──────────────────────────────────────────────────────────────

export const ILinkRepo = {
  getCursor: async (store) => (await store.get(K.ILINK_CURSOR)) ?? '',
  setCursor: (store, cursor) => store.put(K.ILINK_CURSOR, cursor),

  rememberContext: (store, uid, token) => store.put(K.ilinkContext(uid), token, 86400 * 30),
  getContext: async (store, uid) => (await store.get(K.ilinkContext(uid))) ?? '',

  rememberTicket: (store, uid, ticket) => store.put(K.ilinkTicket(uid), ticket, 82800),
  getTicket: async (store, uid) => (await store.get(K.ilinkTicket(uid))) ?? '',

  seen: async (store, messageId, ttl = 600) => {
    if (!messageId) return false;
    const k = K.dedupe(messageId);
    const hit = await store.get(k);
    if (hit) return true;
    await store.put(k, 1, ttl);
    return false;
  },
};
