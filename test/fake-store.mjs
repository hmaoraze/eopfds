/**
 * 内存版 Blob store。语义刻意贴近 @edgeone/pages-blob：
 * - get 未命中返回 null
 * - set(key, value, { onlyIfNew: true }) 在 key 已存在时抛错（这是 SDK 最常见的行为）
 * - list 返回 { blobs: [{ key, pathname }], hasMore }
 *
 * 测试里用它替换真实 Store，因此 npm test 不需要网络、不需要凭证。
 */

export function createFakeStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  let listCalls = 0;
  let getCalls = 0;
  let setCalls = 0;

  return {
    map,

    async get(key) {
      getCalls += 1;
      return map.has(key) ? map.get(key) : null;
    },

    async set(key, value, options = {}) {
      setCalls += 1;
      if (options && options.onlyIfNew === true && map.has(key)) {
        const err = new Error(`blob already exists: ${key}`);
        err.code = 'BLOB_ALREADY_EXISTS';
        throw err;
      }
      map.set(key, value);
      return { key, size: String(value).length };
    },

    async delete(key) {
      map.delete(key);
      return true;
    },

    async list({ prefix = '', limit = 1000 } = {}) {
      listCalls += 1;
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const page = keys.slice(0, limit);
      return {
        blobs: page.map((key) => ({ key, pathname: key, size: String(map.get(key)).length })),
        hasMore: keys.length > limit,
      };
    },

    stats: () => ({ size: map.size, listCalls, getCalls, setCalls }),

    keys: (prefix = '') => [...map.keys()].filter((k) => k.startsWith(prefix)).sort(),

    readJSON: (key) => (map.has(key) ? JSON.parse(map.get(key)) : null),
  };
}
