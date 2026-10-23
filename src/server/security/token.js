/**
 * 服务端自签令牌：<payloadB64url>.<hmacB64url>
 *
 * 用途：
 *   purpose='setup'   首次配置用的临时安全链接
 *   purpose='reauth'  敏感操作前重新签发的安全链接 / 添加新密钥
 *   purpose='admin'   管理端会话令牌（Passkey 认证通过后签发）
 *
 * 安全链接的「一次性」与「立即失效」由 存储中的 jti 状态保证，而不是令牌本身。
 */

import { b64url, hmacSignB64url, utf8, now } from '../lib/util.js';

const VERSION = 'e01';

export async function issueToken(secret, payload) {
  const withMeta = { v: VERSION, iat: now(), ...payload };
  const body = b64url.encode(utf8(JSON.stringify(withMeta)));
  const sig = await hmacSignB64url(secret, body);
  return `${body}.${sig}`;
}

/**
 * @returns {Promise<object|null>} payload（校验失败返回 null）
 */
export async function verifyToken(secret, token, { purpose, audience, tokenId } = {}) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  let expected;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64url.decode(body)));
    expected = payload;
  } catch {
    return null;
  }

  const recomputed = await hmacSignB64url(secret, body);
  if (!constantTimeText(recomputed, sig)) return null;

  if (expected.v !== VERSION) return null;
  if (purpose && expected.purpose !== purpose) return null;
  if (audience && expected.aud !== audience) return null;
  if (tokenId && expected.jti !== tokenId) return null;
  if (expected.exp && Number(expected.exp) <= now()) return null;
  return expected;
}

function constantTimeText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 从请求推导可信 Origin（可被 ADMIN_ORIGINS 覆盖）。 */
export function resolveOrigin(request, cfg) {
  const list = cfg.ADMIN_ORIGIN_LIST || [];
  if (list.length) return list[0];
  const origin = request.headers.get('Origin');
  if (origin) return String(origin).replace(/\/$/, '');
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch { /* noop */ }
  }
  const host = request.headers.get('Host');
  const proto = request.headers.get('X-Forwarded-Proto') || 'https';
  return host ? `${proto}://${host}` : '';
}

export function originToRpId(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}
