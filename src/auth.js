/**
 * 管理面鉴权（C3）。
 *
 * 方案：Bearer Token + HMAC 时间戳签名。
 *   base = METHOD \n PATH \n TIMESTAMP \n sha256(rawBody)
 *   sig  = HMAC-SHA256(ADMIN_HMAC_SECRET, base)
 * 三个都校验：token（常量时间）、时间窗（防重放）、签名（防篡改）。
 *
 * 为什么不接受前端传来的 isAdmin：那是客户端自证，任何人在控制台改一行 JS 就能拿到管理面。
 * 服务端只信自己能验算的东西。
 *
 * openid 通道：仅当同时配置 ADMIN_OPENID_ALLOWLIST 与 ADMIN_OPENID_GATEWAY_SECRET 时启用。
 * 单独用 openid 是不安全的（请求头可任意伪造），所以要求网关用共享密钥对 openid+时间戳签名，
 * 等价于「网关替我们证明了 openid 的真实性」。
 */

import { AppError, ErrorCodes } from './errors.js';
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from './crypto-utils.js';
export const ADMIN_HEADERS = Object.freeze({
  token: 'authorization',
  timestamp: 'x-admin-timestamp',
  signature: 'x-admin-signature',
  openid: 'x-wechat-openid',
  gatewaySignature: 'x-gateway-signature',
});

export async function buildSignatureBase({ method, path, timestamp, rawBody }) {
  const bodyHash = await sha256Hex(rawBody ?? '');
  return `${String(method).toUpperCase()}\n${path}\n${String(timestamp)}\n${bodyHash}`;
}

/** 供测试、运维脚本与文档示例复用，保证签名算法的唯一实现。 */
export async function signAdminRequest({ method, path, timestamp, rawBody, token, secret }) {
  const base = await buildSignatureBase({ method, path, timestamp, rawBody });
  const signature = await hmacSha256Hex(secret, base);
  return {
    headers: {
      authorization: `Bearer ${token}`,
      [ADMIN_HEADERS.timestamp]: String(timestamp),
      [ADMIN_HEADERS.signature]: signature,
    },
    base,
    signature,
  };
}

function unauthorized(reason) {
  // 对外只说「未通过」，具体原因仅用于服务端排障字段
  return new AppError(ErrorCodes.UNAUTHORIZED, '管理面鉴权未通过', 401, { reason });
}

export async function verifyAdminRequest({ request, cfg, method, path, rawBody, now = Date.now() }) {
  if (!cfg.adminToken || !cfg.adminHmacSecret) {
    throw new AppError(ErrorCodes.CONFIG_MISSING, '管理面凭据未配置', 503, {
      requiredMissing: [
        ...(cfg.adminToken ? [] : ['ADMIN_TOKEN']),
        ...(cfg.adminHmacSecret ? [] : ['ADMIN_HMAC_SECRET']),
      ],
    });
  }

  const headers = request.headers;
  const timestampHeader = headers.get(ADMIN_HEADERS.timestamp);
  const signatureHeader = headers.get(ADMIN_HEADERS.signature);
  const authHeader = headers.get(ADMIN_HEADERS.token) ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';

  if (bearer) {
    if (!timestampHeader || !signatureHeader) throw unauthorized('missing_signature_headers');
    const ts = Number(timestampHeader);
    if (!Number.isFinite(ts)) throw unauthorized('bad_timestamp');
    if (Math.abs(now - ts) > cfg.adminAuthMaxSkewMs) throw unauthorized('timestamp_out_of_window');

    if (!(await timingSafeEqual(bearer, cfg.adminToken))) throw unauthorized('bad_token');

    const expected = await hmacSha256Hex(
      cfg.adminHmacSecret,
      await buildSignatureBase({ method, path, timestamp: ts, rawBody }),
    );
    if (!(await timingSafeEqual(expected, signatureHeader))) throw unauthorized('bad_signature');

    return { ok: true, principal: { type: 'token', label: 'admin' } };
  }

  // openid 通道
  const openid = headers.get(ADMIN_HEADERS.openid);
  const gatewaySignature = headers.get(ADMIN_HEADERS.gatewaySignature);
  const openidEnabled = cfg.adminOpenidAllowlist.length > 0 && Boolean(cfg.adminOpenidGatewaySecret);
  if (openid && gatewaySignature) {
    if (!openidEnabled) throw unauthorized('openid_channel_disabled');
    if (!timestampHeader) throw unauthorized('missing_timestamp');
    const ts = Number(timestampHeader);
    if (!Number.isFinite(ts)) throw unauthorized('bad_timestamp');
    if (Math.abs(now - ts) > cfg.adminAuthMaxSkewMs) throw unauthorized('timestamp_out_of_window');
    if (!cfg.adminOpenidAllowlist.includes(openid)) throw unauthorized('openid_not_allowed');

    const expected = await hmacSha256Hex(cfg.adminOpenidGatewaySecret, `${openid}\n${ts}`);
    if (!(await timingSafeEqual(expected, gatewaySignature))) throw unauthorized('bad_gateway_signature');

    return { ok: true, principal: { type: 'openid', label: openid.slice(0, 6) } };
  }

  throw unauthorized('missing_credentials');
}

/**
 * 定时任务鉴权。
 *
 * 为什么支持三种载体：平台内置 schedules 只能配置 path / method / payload，**不能自定义请求头**，
 * 而外部调度器（cron、云函数计时器）通常只能设 header 或 URL。所以按
 * header(x-cron-secret) → query(?token=) → body(payload.token) 的顺序取凭据。
 *
 * 安全取舍：query 与 body 里的密钥可能进入访问日志或构建产物，优先用 header；
 * 必须用平台 schedules 时，建议把任务项配在控制台而不是提交进仓库，并在轮换时同步更新。
 */
export async function verifyCronRequest({ request, cfg, url, payload }) {
  if (!cfg.cronSecret) {
    throw new AppError(ErrorCodes.CONFIG_MISSING, '定时任务密钥未配置', 503, {
      requiredMissing: ['CRON_SECRET'],
    });
  }

  const fromHeader = request?.headers?.get?.('x-cron-secret') ?? '';
  const fromQuery = url?.searchParams?.get('token') ?? '';
  const fromBody = typeof payload?.token === 'string' ? payload.token : '';
  const provided = fromHeader || fromQuery || fromBody;

  if (!provided) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, '定时任务鉴权未通过', 401, { reason: 'missing_cron_secret' });
  }
  if (!(await timingSafeEqual(provided, cfg.cronSecret))) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, '定时任务鉴权未通过', 401, { reason: 'bad_cron_secret' });
  }

  return { ok: true, via: fromHeader ? 'header' : (fromQuery ? 'query' : 'payload') };
}
