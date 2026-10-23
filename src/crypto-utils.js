/**
 * 密码学工具。全部基于 WebCrypto（globalThis.crypto.subtle）：
 * EdgeOne Makers Functions 的 V8 运行时与 Node 20+ 都内置，无需引入第三方库。
 */

const encoder = new TextEncoder();

function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(new Uint8Array(sig));
}

/**
 * 常量时间比较。先各自哈希再比 hex，长度恒定，避免用长度差推断凭据长度。
 * 直接比较原文会因为提前 return 泄漏前缀匹配位数。
 */
export async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i += 1) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export function randomToken(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  // base62 截断：去掉容易混淆的 +/= 字符，保证可直接进 URL 与 Blob key
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, byteLength * 2);
}

/**
 * 脱敏：保留可辨识前缀 + 尾 4 位，形如 sk-****abcd。
 * 长度不足 12 的一律全遮，避免短密钥被反推。
 */
export function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length < 12) return '****';
  const prefix = value.startsWith('sk-') ? 'sk-' : value.slice(0, 3);
  return `${prefix}****${value.slice(-4)}`;
}
