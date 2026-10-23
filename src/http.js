/**
 * HTTP 响应与请求体处理。
 * 统一在这里保证：错误响应体结构一致、缓存禁用、不泄漏内部信息。
 */

import { AppError, ErrorCodes } from './errors.js';

const BASE_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  // 所有接口都返回用户相关数据，禁止任何中间层缓存
  'cache-control': 'no-store, no-cache, must-revalidate',
  'x-content-type-options': 'nosniff',
});

export function jsonResponse(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function errorResponse(err, requestId) {
  const isApp = err instanceof AppError;
  const payload = isApp
    ? err.toPayload()
    : { error: { code: ErrorCodes.INTERNAL_ERROR, message: '服务内部错误' } };
  payload.error.requestId = requestId;
  const status = isApp ? err.status : 500;
  return jsonResponse(payload, { status, headers: { 'x-request-id': requestId } });
}

export async function readTextBody(request, maxBytes = 128 * 1024) {
  let text = '';
  try {
    text = await request.text();
  } catch {
    throw new AppError(ErrorCodes.BAD_REQUEST, '无法读取请求体', 400);
  }
  if (text.length > maxBytes) {
    throw new AppError(ErrorCodes.PAYLOAD_TOO_LARGE, `请求体超过 ${maxBytes} 字节上限`, 413);
  }
  return text;
}

export function parseJson(rawText) {
  if (!rawText || rawText.trim() === '') return {};
  try {
    const parsed = JSON.parse(rawText);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new AppError(ErrorCodes.BAD_REQUEST, '请求体不是合法 JSON', 400);
  }
}

/** 请求体内存化：同一个请求只读一次流（Web 标准 Request 的 body 不可重放）。 */
export function createBodyReader(request, maxBytes) {
  let rawPromise;
  let parsedValue;
  let parsed = false;

  const getRaw = () => {
    rawPromise ??= readTextBody(request, maxBytes);
    return rawPromise;
  };

  return {
    raw: getRaw,
    async json() {
      if (!parsed) {
        parsedValue = parseJson(await getRaw());
        parsed = true;
      }
      return parsedValue;
    },
  };
}
