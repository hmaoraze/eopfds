/**
 * 应用层互斥锁。
 *
 * Blob 没有 CAS，所以锁只能靠「key 不存在才创建」这个原子语义加：
 *   acquire = set(lockKey, {token, expiresAt}, { onlyIfNew: true })
 * 拿到锁的进程是唯一写入者；锁带租约，进程被杀死时靠过期时间自愈，
 * 避免一个超时请求把会话永久锁死。
 *
 * 释放时必须校验 token：A 的租约过期、B 抢到锁，此时 A 的 finally 不能删 B 的锁。
 */

import { AppError, ErrorCodes } from './errors.js';
import { randomToken } from './crypto-utils.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withLock(repo, key, fn, options = {}) {
  const {
    ttlMs = 20000,
    waitMs = 30000,
    pollMs = 40,
    now = () => Date.now(),
  } = options;

  const token = randomToken(12);
  const deadline = now() + waitMs;
  let acquired = false;

  while (!acquired) {
    const ok = await repo.setJSONIfAbsent(key, {
      token,
      acquiredAt: now(),
      expiresAt: now() + ttlMs,
    });
    if (ok) {
      acquired = true;
      break;
    }

    const current = await repo.getJSON(key, { tolerant: true });
    if (current && typeof current.expiresAt === 'number' && current.expiresAt <= now()) {
      // 租约过期：清掉再抢。两个进程同时清也无所谓，最终只有一个能 onlyIfNew 成功。
      await repo.deleteKey(key).catch(() => {});
      continue;
    }

    if (now() >= deadline) {
      throw new AppError(ErrorCodes.LOCK_TIMEOUT, '资源被占用，请稍后重试', 409, { key });
    }
    await sleep(pollMs);
  }

  try {
    return await fn();
  } finally {
    try {
      const current = await repo.getJSON(key, { tolerant: true });
      if (current?.token === token) await repo.deleteKey(key);
    } catch {
      // 释放失败不影响业务结果，锁会在 ttlMs 后自动过期
    }
  }
}
