/**
 * Blob 访问层。
 *
 * 关键决策（对应 A2 / A3 / A7）：
 * - Store 以 consistency: "strong" 创建。会话续接和记忆写入都是「写后立即读」，
 *   默认最终一致会让上一轮刚写的消息在下一轮 list/get 里读不到，表现为「机器人失忆」。
 * - 这里不做任何缓存（进程内也不做）。strong 一致的意义就是每次读都打到主存储，
 *   在应用层再缓存一层会把这个保证直接废掉。
 * - 所有写入都走「一条记录一文件」的 key，唯一例外是会话文档（见 session-service）。
 */

import { AppError, ErrorCodes } from './errors.js';

const ALREADY_EXISTS_RE = /exist|already|conflict|overwrit|duplicate|precondition/i;

function isAlreadyExistsError(err) {
  if (!err) return false;
  const code = String(err.code ?? err.name ?? '');
  if (ALREADY_EXISTS_RE.test(code)) return true;
  return ALREADY_EXISTS_RE.test(String(err.message ?? ''));
}

function storageError(operation, key, err) {
  return new AppError(ErrorCodes.STORAGE_UNAVAILABLE, `Blob ${operation} 失败`, 503, {
    operation,
    key,
    reason: String(err?.message ?? err).slice(0, 200),
  });
}

function normalizeListEntry(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  return entry.key ?? entry.pathname ?? entry.name ?? entry.path ?? null;
}

/**
 * 在 Blob store 之上包一层类型化仓储。所有上层模块只依赖这个对象，
 * 不直接碰 SDK，测试时用内存实现替换即可。
 */
export function createRepo(store) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new AppError(ErrorCodes.STORAGE_UNAVAILABLE, 'Blob store 实例不可用', 503);
  }

  /**
   * 读取原始值，兼容两种 SDK 形态：
   *   - `store.getJSON(key)`：部分版本的便捷方法，文档未列出，不能假设一定存在；
   *   - `store.get(key, { type: 'json' })`：文档化 API。
   * 若实现忽略了第二个参数（返回字符串），下面统一 JSON.parse 兜底。
   */
  async function readRaw(key, { tolerant }) {
    try {
      if (typeof store.getJSON === 'function') return await store.getJSON(key);
      return await store.get(key, { type: 'json' });
    } catch (err) {
      if (tolerant) return null;
      throw storageError('get', key, err);
    }
  }

  async function getJSON(key, { tolerant = false } = {}) {
    const raw = await readRaw(key, { tolerant });
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    const text = String(raw).trim();
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      if (tolerant) return null;
      throw new AppError(ErrorCodes.STORAGE_UNAVAILABLE, 'Blob 内容损坏（非合法 JSON）', 500, { key });
    }
  }

  /** 写入原始值，同样兼容 setJSON / set 两种形态。 */
  async function writeRaw(key, value, options) {
    if (typeof store.setJSON === 'function') return store.setJSON(key, value, options);
    return store.set(key, JSON.stringify(value), options);
  }

  async function setJSON(key, value) {
    try {
      return await writeRaw(key, value);
    } catch (err) {
      throw storageError('set', key, err);
    }
  }

  /**
   * 幂等写入第一道防线：key 不存在才写。
   * 返回值 true = 本次确实写入；false = 已存在（调用方应转入合并分支）。
   *
   * 兼容三种「已存在」表达：抛异常 / 返回 existed|conflict|updated 标记 / 静默覆盖。
   * 最后一种无法在本层识别（SDK 直接覆盖并返回成功），但业务层不受影响：
   * memoryId = sha256(content)，被覆盖写进去的是同一份 content，只有 mergeCount 可能回退。
   * 因此去重正确性由「写前哈希命中检查」保证，onlyIfNew 只是并发窗口的收窄手段。
   */
  async function setJSONIfAbsent(key, value) {
    let res;
    try {
      res = await writeRaw(key, value, { onlyIfNew: true });
    } catch (err) {
      if (isAlreadyExistsError(err)) return false;
      throw storageError('set(onlyIfNew)', key, err);
    }
    if (res === false) return false;
    if (res && typeof res === 'object') {
      if (res.existed === true || res.conflict === true || res.updated === false) return false;
    }
    return true;
  }

  async function listKeys(prefix, { limit = 1000, pageSize = 500 } = {}) {
    const collected = [];
    let cursor;
    // list 是分页的，且没有 delimiter，靠前缀扫描；扫描上限由调用方传入，避免一次拉爆
    for (let guard = 0; guard < 50; guard += 1) {
      let res;
      try {
        res = await store.list({
          prefix,
          limit: Math.min(pageSize, limit),
          ...(cursor ? { cursor } : {}),
        });
      } catch (err) {
        throw storageError('list', prefix, err);
      }

      const entries = Array.isArray(res)
        ? res
        : (res?.blobs ?? res?.keys ?? res?.items ?? []);
      for (const entry of entries) {
        const key = normalizeListEntry(entry);
        if (key) collected.push(key);
        if (collected.length >= limit) return collected;
      }

      cursor = res?.cursor ?? res?.nextCursor ?? res?.next ?? null;
      const explicit = res?.hasMore ?? res?.truncated;
      const hasMore = explicit !== undefined
        ? explicit === true
        : (res?.complete === false || Boolean(cursor));
      if (!cursor || !hasMore) break;
    }
    return collected;
  }

  async function deleteKey(key) {
    try {
      return await store.delete(key);
    } catch (err) {
      throw storageError('delete', key, err);
    }
  }

  return { raw: store, getJSON, setJSON, setJSONIfAbsent, listKeys, deleteKey };
}

// Store 实例在同一个 isolate 内复用；按 store 名做键，避免多 Store 场景串用
const storeCache = new Map();

/**
 * 解析 Blob store。
 * 注意 getStore 的调用形态固定为 { name, consistency: 'strong' }，
 * 不要改成单独传 name 的旧写法——旧写法拿不到强一致开关。
 */
export async function resolveStore(cfg, override) {
  if (override) return override;
  if (!cfg.blobStoreName) {
    throw new AppError(ErrorCodes.CONFIG_MISSING, 'Blob Store 名称未配置', 503, {
      requiredMissing: ['BLOB_STORE_NAME'],
    });
  }
  const cached = storeCache.get(cfg.blobStoreName);
  if (cached) return cached;

  let mod;
  try {
    mod = await import('@edgeone/pages-blob');
  } catch (err) {
    throw new AppError(ErrorCodes.STORAGE_UNAVAILABLE, '未安装 @edgeone/pages-blob（需 >= 0.0.14）', 503, {
      reason: String(err?.message ?? err).slice(0, 200),
    });
  }
  if (typeof mod?.getStore !== 'function') {
    throw new AppError(ErrorCodes.STORAGE_UNAVAILABLE, '@edgeone/pages-blob 未导出 getStore', 503);
  }

  const store = mod.getStore({ name: cfg.blobStoreName, consistency: 'strong' });
  storeCache.set(cfg.blobStoreName, store);
  return store;
}

export function resetStoreCache() {
  storeCache.clear();
}
