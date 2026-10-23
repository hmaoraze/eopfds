/**
 * 存储抽象层 —— 统一键值接口。
 *
 * 所有驱动都只依赖 fetch / Web 标准 API：
 *   edgeone-kv   EdgeOne Pages KV 命名空间（控制台绑定后的全局变量，亦可从 context.env 取）
 *   redis-rest   Upstash / Redis HTTP REST（无长连接，适合边缘）
 *   http         自建极简键值服务（GET/PUT/DELETE ?key=）
 *   memory       进程内存（仅本地调试，边缘节点间不共享）
 *
 * 逻辑 TTL：驱动不支持过期时，统一在本层做「惰性过期」兜底。
 */

const WRAPPER_VERSION = 1;

function wrap(value, ttlSeconds) {
  return JSON.stringify({
    __v: WRAPPER_VERSION,
    v: value,
    e: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0,
  });
}

function unwrap(raw) {
  if (raw === null || raw === undefined) return undefined;
  let parsed;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined; // 非本系统写入的数据，忽略
    }
  } else {
    parsed = raw;
  }
  if (!parsed || parsed.__v !== WRAPPER_VERSION) return undefined;
  if (parsed.e && parsed.e < Date.now()) return undefined; // 惰性过期
  return parsed.v;
}

/** 统一二级驱动接口（原始字符串），再加逻辑 TTL 兜底。 */
function withTtl(driver) {
  return {
    name: driver.name,
    async get(key) {
      return unwrap(await driver.get(key));
    },
    async put(key, value, ttlSeconds) {
      return driver.put(key, wrap(value, ttlSeconds), ttlSeconds);
    },
    async delete(key) {
      return driver.delete(key);
    },
    async list(prefix, limit) {
      return driver.list ? driver.list(prefix, limit) : [];
    },
  };
}

// ── EdgeOne Pages KV ───────────────────────────────────────────────────

function resolveBinding(bindingName, env) {
  try {
    const g = globalThis[bindingName];
    if (g && typeof g.get === 'function') return g;
  } catch (_) { /* noop */ }
  try {
    const e = env?.[bindingName];
    if (e && typeof e.get === 'function') return e;
  } catch (_) { /* noop */ }
  // 部分平台把绑定挂在 env.KV / env.__KV
  try {
    const alt = env?.KV || env?.__KV__;
    if (alt && typeof alt.get === 'function') return alt;
  } catch (_) { /* noop */ }
  return null;
}

function edgeoneKvDriver(binding) {
  const putOptions = (ttl) => {
    const t = Number(ttl);
    if (!Number.isFinite(t) || t <= 0) return undefined;
    return { expirationTtl: t };
  };
  return {
    name: 'edgeone-kv',
    async get(key) {
      try {
        return await binding.get(key, 'text');
      } catch {
        return await binding.get(key);
      }
    },
    async put(key, value, ttl) {
      const opts = putOptions(ttl);
      try {
        if (opts) {
          await binding.put(key, value, opts);
          return true;
        }
        await binding.put(key, value);
        return true;
      } catch {
        try {
          await binding.put(key, value, { expiration: opts ? Math.floor(Date.now() / 1000 + opts.expirationTtl) : undefined });
          return true;
        } catch (e) {
          throw new Error(`KV put 失败: ${e.message}`);
        }
      }
    },
    async delete(key) {
      await binding.delete(key);
      return true;
    },
  };
}

// ── Redis REST（Upstash 风格） ─────────────────────────────────────────

function redisRestDriver(url, token) {
  const base = String(url).replace(/\/+$/, '');
  const headers = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const enc = encodeURIComponent;

  async function call(pathname, init) {
    const res = await fetch(`${base}${pathname}`, init);
    if (!res.ok) throw new Error(`Redis REST ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  return {
    name: 'redis-rest',
    async get(key) {
      const r = await call(`/get/${enc(key)}`, { headers: headers() });
      return r.result === null || r.result === undefined ? null : r.result;
    },
    async put(key, value, ttl) {
      const t = Number(ttl);
      const suffix = Number.isFinite(t) && t > 0 ? `/EX/${Math.ceil(t)}` : '';
      // 用 set 路径传递可能导致超长 URL 或特殊字符问题，改走 pipeline body
      const args = Number.isFinite(t) && t > 0
        ? ['SET', key, value, 'EX', String(Math.ceil(t))]
        : ['SET', key, value];
      const r = await fetch(`${base}/pipeline`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify([args]),
      });
      if (!r.ok) {
        await call(`/set/${enc(key)}/${enc(value)}${suffix}`, { headers: headers() });
      }
      return true;
    },
    async delete(key) {
      await fetch(`${base}/pipeline`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify([['DEL', key]]),
      }).catch(async () => {
        await call(`/del/${enc(key)}`, { headers: headers(), method: 'GET' });
      });
      return true;
    },
  };
}

// ── 通用 HTTP 键值服务 ─────────────────────────────────────────────────

function httpStoreDriver(baseUrl, token) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const headers = () => ({
    Authorization: token ? `Bearer ${token}` : '',
    'Content-Type': 'application/json',
  });
  return {
    name: 'http',
    async get(key) {
      const res = await fetch(`${base}/?key=${encodeURIComponent(key)}`, { headers: headers() });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP store ${res.status}`);
      const j = await res.json();
      return j.value ?? j.v ?? null;
    },
    async put(key, value, ttl) {
      const res = await fetch(`${base}/`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ key, value, ttlSeconds: ttl || 0 }),
      });
      if (!res.ok) throw new Error(`HTTP store put ${res.status}`);
      return true;
    },
    async delete(key) {
      const res = await fetch(`${base}/?key=${encodeURIComponent(key)}`, { method: 'DELETE', headers: headers() });
      return res.ok || res.status === 404;
    },
  };
}

// ── 内存（调试） ───────────────────────────────────────────────────────

function memoryDriver(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    name: 'memory',
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
      return true;
    },
    async delete(key) {
      map.delete(key);
      return true;
    },
    async list(prefix, limit = 500) {
      const out = [];
      for (const k of map.keys()) {
        if (k.startsWith(prefix)) out.push(k);
        if (out.length >= limit) break;
      }
      return out;
    },
  };
}

// ── 工厂 ───────────────────────────────────────────────────────────────

/**
 * @param {object} cfg  buildConfig 产物
 * @param {object} [env] 平台环境变量对象（context.env）
 * @param {object} [options] { seed } 供本地调试注入
 */
export function createStore(cfg, env, options = {}) {
  const driverKind = String(cfg.STORE_DRIVER || 'edgeone-kv');
  let driver;

  if (driverKind === 'redis-rest') {
    if (!cfg.REDIS_REST_URL || !cfg.REDIS_REST_TOKEN) {
      throw new Error('STORE_DRIVER=redis-rest 需要配置 REDIS_REST_URL 与 REDIS_REST_TOKEN');
    }
    driver = redisRestDriver(cfg.REDIS_REST_URL, cfg.REDIS_REST_TOKEN);
  } else if (driverKind === 'http') {
    if (!cfg.HTTP_STORE_URL) throw new Error('STORE_DRIVER=http 需要配置 HTTP_STORE_URL');
    driver = httpStoreDriver(cfg.HTTP_STORE_URL, cfg.HTTP_STORE_TOKEN);
  } else if (driverKind === 'memory') {
    driver = memoryDriver(options.seed);
  } else {
    const binding = resolveBinding(cfg.KV_BINDING_NAME || 'WECHATBOT_KV', env);
    if (!binding) {
      // 开发环境回落到内存，并明确提示
      if (options.allowMemoryFallback) {
        driver = memoryDriver(options.seed);
        driver.name = 'memory(fallback)';
      } else {
        throw new Error(
          `未找到 KV 命名空间绑定「${cfg.KV_BINDING_NAME}」。请在 EdgeOne Pages 控制台 → 环境变量与绑定中添加同名绑定到 KV 命名空间，并将「KV 绑定变量名」配置保持一致。`,
        );
      }
    } else {
      driver = edgeoneKvDriver(binding);
    }
  }
  return withTtl(driver);
}

export const __test__ = { wrap, unwrap, memoryDriver };
