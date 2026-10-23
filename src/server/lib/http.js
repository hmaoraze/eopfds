/** HTTP 响应构造、CORS 与 JSON 辅助。 */

// ── iLink 业务错误码（与 wechatbot.dev 协议一致） ────────────────────────
export const RET = {
  OK: 0,
  PARAM: -2,
  SESSION_EXPIRED: -14,
  UNAUTHORIZED: -401,
  FORBIDDEN: -403,
  RATE_LIMITED: -429,
  UPSTREAM: -500,
  TIMEOUT: -504,
};

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function corsHeaders(origin, allowCredentials = false) {
  if (!origin) return {};
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Admin-Token,X-Secure-Link',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowCredentials) headers['Access-Control-Allow-Credentials'] = 'true';
  return headers;
}

/** 标准成功响应：{ ret: 0, ... } */
export function ok(payload = {}, init = {}) {
  const body = JSON.stringify({ ret: RET.OK, ...payload });
  return new Response(body, {
    status: 200,
    headers: { ...DEFAULT_HEADERS, ...(init.headers || {}) },
  });
}

/** 业务错误响应：HTTP 200 + ret != 0（参照 iLink 用 ret 表达业务错误）。 */
export function fail(ret, message, init = {}) {
  const body = JSON.stringify({ ret, errmsg: message || 'unknown error' });
  return new Response(body, {
    status: init.status || 200,
    headers: { ...DEFAULT_HEADERS, ...(init.headers || {}) },
  });
}

export function notFound(message = 'not found') {
  return new Response(JSON.stringify({ ret: RET.PARAM, errmsg: message }), {
    status: 404,
    headers: DEFAULT_HEADERS,
  });
}

export function html(body, init = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    ...init,
  });
}

export function preflight(origin, allowCredentials = false) {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(origin, allowCredentials) },
  });
}

export async function readJson(request, maxBytes = 256 * 1024) {
  const raw = await request.text();
  if (raw.length > maxBytes) throw new HttpError(RET.PARAM, `请求体过大（上限 ${maxBytes} 字节）`);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(RET.PARAM, '请求体不是合法 JSON');
  }
}

export class HttpError extends Error {
  constructor(ret, message, status = 200) {
    super(message);
    this.name = 'HttpError';
    this.ret = ret;
    this.status = status;
  }
}

/** 统一错误处理：把异常转成协议响应。 */
export function toErrorResponse(error) {
  if (error instanceof HttpError) return fail(error.ret, error.message, { status: error.status });
  return fail(RET.UPSTREAM, `服务异常：${error?.message || String(error)}`);
}

/** 极简速率限制（每 key 每窗口计数，存于 KV）。 */
export async function rateLimit(store, key, limit, windowMs) {
  const bucket = `${key}:${Math.floor(Date.now() / windowMs)}`;
  const cur = Number((await store.get(bucket)) || 0);
  if (cur >= limit) return false;
  await store.put(bucket, String(cur + 1), Math.ceil((windowMs * 2) / 1000));
  return true;
}
