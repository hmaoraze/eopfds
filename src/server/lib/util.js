/**
 * 基础工具库 —— 仅使用 Web 标准 API（TextEncoder/TextDecoder、crypto.subtle、Uint8Array）。
 * 禁止引入任何 Node 专有模块（buffer / crypto / process 等）。
 */

const TE = new TextEncoder();
const TD = new TextDecoder();

// ── 编码：UTF-8 <-> Uint8Array ──────────────────────────────────────────

export function utf8(str) {
  return TE.encode(String(str));
}

export function str(bytes) {
  return TD.decode(bytes);
}

// ── Base64 / Base64URL ─────────────────────────────────────────────────

const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToB64(bytes, alphabet = B64_STD) {
  const out = [];
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out.push(alphabet[b0 >> 2]);
    out.push(alphabet[((b0 & 0x03) << 4) | (b1 >> 4)]);
    out.push(i + 1 < len ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=');
    out.push(i + 2 < len ? alphabet[b2 & 0x3f] : '=');
  }
  return out.join('');
}

function b64ToBytes(text, alphabet = B64_STD) {
  const clean = String(text).replace(/[=]+$/, '').replace(/\s+/g, '');
  const len = clean.length;
  const outLen = Math.floor((len * 6) / 8);
  const bytes = new Uint8Array(outLen);
  let bitBuf = 0;
  let bitCount = 0;
  let pos = 0;
  for (let i = 0; i < len; i++) {
    const idx = alphabet.indexOf(clean[i]);
    if (idx < 0) throw new Error(`非法 base64 字符: ${clean[i]}`);
    bitBuf = (bitBuf << 6) | idx;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[pos++] = (bitBuf >> bitCount) & 0xff;
    }
  }
  return bytes.subarray(0, pos);
}

export const b64encode = (bytes) => bytesToB64(bytes, B64_STD);
export const b64decode = (text) => b64ToBytes(text, B64_STD);
export const b64url = {
  encode(bytes) {
    return bytesToB64(bytes, B64_URL).replace(/=+$/, '');
  },
  decode(text) {
    let t = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const pad = t.length % 4;
    if (pad) t += '='.repeat(4 - pad);
    return b64ToBytes(t, B64_STD);
  },
};

// ── Hex ────────────────────────────────────────────────────────────────

export function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function unhex(text) {
  const t = String(text).replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(t.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
  return out;
}

// ── 字节工具 ───────────────────────────────────────────────────────────

export function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

/** 恒定时间比较，避免计时侧信道。 */
export function timingSafeEqual(a, b) {
  const x = a instanceof Uint8Array ? a : utf8(String(a));
  const y = b instanceof Uint8Array ? b : utf8(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

/** 安全字符串比较（先哈希再比长度与内容，减少信息泄露）。 */
export async function safeCompare(a, b) {
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(String(a))));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(String(b))));
  return timingSafeEqual(ha, hb);
}

// ── 随机数 / ID ────────────────────────────────────────────────────────

export function randomBytes(len) {
  return crypto.getRandomValues(new Uint8Array(len));
}

/** URL 安全的随机 ID（默认 22 字符 ≈ 132 bit）。 */
export function randomToken(len = 22) {
  return b64url.encode(randomBytes(len));
}

/** RFC 4122 v4 UUID —— 用于 iLink client_id。 */
export function uuidV4() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** iLink 协议要求：随机 uint32 → 十进制字符串 → base64。 */
export function randomWechatUin() {
  const b = randomBytes(4);
  const value = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  return b64encode(utf8(String(value)));
}

// ── 摘要 / HMAC ────────────────────────────────────────────────────────

export async function sha256(data) {
  const buf = typeof data === 'string' ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

export async function sha256Hex(data) {
  return hex(await sha256(data));
}

/** 短哈希：用于记忆去重指纹。 */
export async function shortHash(data, length = 16) {
  return (await sha256Hex(typeof data === 'string' ? data : String(data))).slice(0, length);
}

async function hmacKey(secretText) {
  return crypto.subtle.importKey(
    'raw',
    typeof secretText === 'string' ? utf8(secretText) : secretText,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function hmacSign(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? utf8(data) : data);
  return new Uint8Array(sig);
}

export async function hmacSignB64url(secret, data) {
  return b64url.encode(await hmacSign(secret, data));
}

export async function hmacVerify(secret, data, signatureBytes) {
  const expect = new Uint8Array(await hmacSign(secret, typeof data === 'string' ? utf8(data) : data));
  const actual = signatureBytes instanceof Uint8Array ? signatureBytes : b64url.decode(signatureBytes);
  return timingSafeEqual(expect, actual);
}

// ── 杂项 ───────────────────────────────────────────────────────────────

export const now = () => Date.now();

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function truncate(text, max, ellipsis = '…') {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
}

/** 不存在则返回默认值，接受布尔字符串/数字字符串自动转换。 */
export function pick(source, key, fallback) {
  const v = source?.[key];
  return v === undefined || v === null || v === '' ? fallback : v;
}
