/**
 * 管理端 JSON API。
 *
 * 未认证可用：
 *   bootstrap-state      是否已完成首次配置
 *   secure-link          凭 ADMIN_MASTER_KEY 签发一次性安全链接（首次进入）
 *   link-status          校验安全链接是否有效
 *   register-options     生成 Passkey 注册挑战
 *   register-verify      校验注册断言 → 安全链接立即失效 → 签发管理端会话
 *   auth-options         生成 Passkey 登录挑战
 *   auth-verify          校验登录断言 → 签发管理端会话
 *   schema               下发配置项元数据（无需认证，仅字段定义）
 *
 * 需管理端会话：
 *   session-state / logout / config-get / config-save
 *   passkeys-list / reauth-options / passkey-add-options / passkey-remove / reset-passkeys
 *   issue-secure-link / ilink-qrcode / ilink-qrstatus
 *   users-list / memory-list / memory-delete / memory-purge / session-list / session-end
 *   audit-list / sweep
 */

import { createRuntime } from '../index.js';
import { GROUPS, SCHEMA } from '../config/schema.js';
import { sanitizeOverrides, serializeConfigForAdmin, buildConfig, validateConfig } from '../config/index.js';
import { readJson, HttpError, toErrorResponse, corsHeaders, RET, rateLimit } from '../lib/http.js';
import { K, ConfigRepo, AdminRepo, PasskeyRepo, SessionRepo, getJson } from '../repository.js';
import { issueToken, verifyToken, resolveOrigin } from '../security/token.js';
import {
  buildRegistrationOptions, buildAuthenticationOptions, verifyRegistration, verifyAuthentication, WebAuthnError,
} from '../security/webauthn.js';
import { randomBytes, randomToken, now, safeCompare, b64url } from '../lib/util.js';

const ADMIN_COOKIE = 'wb_admin';

function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function adminCookieAttrs(request, cfg, maxAgeSeconds) {
  const secure = !String(resolveOrigin(request, cfg)).startsWith('http://');
  return `${ADMIN_COOKIE}=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}; ${secure ? 'Secure;' : ''}`;
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || request.headers.get('EO-Client-IP')
    || 'unknown';
}

export async function handleAdminRequest(context) {
  const request = context.request;
  let rt;
  try {
    rt = await createRuntime(context, { allowMemoryFallback: false });
  } catch (e) {
    return json({ ret: RET.UPSTREAM, errmsg: `初始化失败：${e.message}` }, 500, '*');
  }
  const { cfg, store, log } = rt;
  const origin = resolveOrigin(request, cfg) || '*';
  const useCredentials = origin !== '*';
  const cors = corsHeaders(origin, true);

  const reply = (payload, status = 200, extraHeaders = {}) =>
    json({ ret: RET.OK, ...payload }, status, origin, { ...cors, ...extraHeaders }, useCredentials);

  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST' && request.method !== 'GET') {
      throw new HttpError(RET.PARAM, '仅支持 GET/POST', 405);
    }

    const body = request.method === 'POST' ? await readJson(request) : {};
    const params = new URL(request.url).searchParams;
    const op = String(body.op || params.get('op') || 'bootstrap-state');

    const ip = clientIp(request);
    if (!(await allowed(store, ip, Number(cfg.ADMIN_RATE_LIMIT) || 30))) {
      throw new HttpError(RET.RATE_LIMITED, '管理端请求过于频繁，请稍后再试');
    }

    const admin = op.startsWith('link-') || op === 'bootstrap-state' || op === 'secure-link'
      || op === 'register-options' || op === 'register-verify'
      || op === 'auth-options' || op === 'auth-verify' || op === 'schema';

    const session = admin ? null : await requireSession(rt, request);
    const args = { rt, cfg, store, log, body, request, reply, session, ip };

    switch (op) {
      case 'bootstrap-state': return await opBootstrapState(args);
      case 'schema': return await opSchema(args);
      case 'secure-link': return await opSecureLink(args, false);
      case 'issue-secure-link': return await opSecureLink(args, true);
      case 'link-status': return await opLinkStatus(args);
      case 'register-options': return await opRegisterOptions(args);
      case 'register-verify': return await opRegisterVerify(args);
      case 'auth-options': return await opAuthOptions(args);
      case 'auth-verify': return await opAuthVerify(args);
      case 'session-state': return await opSessionState(args);
      case 'logout': return await opLogout(args);
      case 'config-get': return await opConfigGet(args);
      case 'config-save': return await opConfigSave(args);
      case 'passkeys-list': return await opPasskeysList(args);
      case 'reauth-options': return await opReauthOptions(args);
      case 'passkey-add-options': return await opPasskeyAddOptions(args);
      case 'passkey-remove': return await opPasskeyRemove(args);
      case 'reset-passkeys': return await opResetPasskeys(args);
      case 'ilink-qrcode': return await opILinkQrcode(args);
      case 'ilink-qrstatus': return await opILinkQrstatus(args);
      case 'users-list': return await opUsersList(args);
      case 'session-list': return await opSessionList(args);
      case 'session-end': return await opSessionEnd(args);
      case 'memory-list': return await opMemoryList(args);
      case 'memory-delete': return await opMemoryDelete(args);
      case 'memory-purge': return await opMemoryPurge(args);
      case 'sweep': return await opSweep(args);
      case 'audit-list': return await opAuditList(args);
      default: throw new HttpError(RET.PARAM, `未知操作 ${op}`);
    }
  } catch (error) {
    log('error', 'admin:error', { message: error?.message, op: request.url });
    const res = toErrorResponse(error);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
}

// ── 会话校验 ────────────────────────────────────────────────────────────

async function requireSession(rt, request) {
  const cfg = rt.cfg;
  const cookies = parseCookies(request);
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const token = cookies[ADMIN_COOKIE] || bearer;
  if (!token) throw new HttpError(RET.UNAUTHORIZED, '未认证：请先通过 Passkey 登录管理端', 401);

  const payload = await verifyToken(cfg.ADMIN_SIGNING_SECRET, token, { purpose: 'admin' });
  if (!payload) throw new HttpError(RET.UNAUTHORIZED, '管理端会话无效或已过期', 401);

  const data = await AdminRepo.getSession(rt.store, payload.jti);
  if (!data || data.expiresAt <= now()) {
    throw new HttpError(RET.UNAUTHORIZED, '管理端会话已失效，请重新登录', 401);
  }
  return { ...data, jti: payload.jti, token };
}

async function allowed(store, ip, limit) {
  return rateLimit(store, `${K.rate('admin', Math.floor(now() / 60000), ip)}`, limit, 60000);
}

// ── 操作实现 ────────────────────────────────────────────────────────────

async function opBootstrapState({ rt, reply }) {
  const setup = await ConfigRepo.getSetup(rt.store);
  const passkeys = await PasskeyRepo.list(rt.store);
  const validity = rt.validate();
  return reply({
    initialized: Boolean(setup.initialized) && passkeys.length > 0,
    passkeyCount: passkeys.length,
    configComplete: validity.ok,
    missingRequired: validity.ok ? [] : validity.missing.map((m) => m.key),
  });
}

async function opSchema({ reply }) {
  return reply({
    groups: GROUPS,
    schema: SCHEMA.map(({ key, label, group, type, required, default: def, options, min, max, rows, placeholder, desc, dependsOn }) => ({
      key, label, group, type, required: Boolean(required), default: def, options, min, max, rows, placeholder, desc, dependsOn,
    })),
  });
}

async function opSecureLink({ rt, request, body, reply, session, cfg, log, ip }, fromSession) {
  // 两种来源：
  //   fromSession=false  凭据来自 ADMIN_MASTER_KEY（首次进入）
  //   fromSession=true   已登录管理员签发，给新设备/新密钥使用（可要求重新 Passkey 断言）
  const providedKey = String(request.headers.get('X-Admin-Master-Key') || body.masterKey || '');
  if (!fromSession) {
    if (!providedKey) throw new HttpError(RET.UNAUTHORIZED, '缺少 X-Admin-Master-Key 请求头', 401);
    if (!(await safeCompare(cfg.ADMIN_MASTER_KEY, providedKey))) {
      throw new HttpError(RET.FORBIDDEN, '主密钥不正确', 403);
    }
  } else if (cfg.ADMIN_STEP_UP_REAUTH !== false) {
    await requireReauth(rt, body.reauthToken); // 敏感操作：必须刚完成一次 Passkey 断言
  }

  const ttl = Number(cfg.SECURE_LINK_TTL_SECONDS) || 900;
  const jti = randomToken(16);
  const purpose = body.purpose === 'add-passkey' ? 'add-passkey' : 'setup';
  await AdminRepo.putLink(rt.store, jti, {
    jti, purpose, used: false, createdAt: now(), expiresAt: now() + ttl * 1000,
    createdBy: fromSession ? 'admin-session' : 'master-key',
    ip,
  }, ttl);

  const token = await issueToken(cfg.ADMIN_SIGNING_SECRET, { purpose: 'setup', jti, exp: now() + ttl * 1000 });
  const base = new URL(request.url).origin;
  await AdminRepo.audit(rt.store, { action: 'issue-secure-link', purpose, ip, jti });
  log('info', 'admin:secure-link', { jti, purpose, ttl });

  return reply({
    token,
    url: `${base}/admin/?link=${token}`,
    purpose,
    expiresAt: now() + ttl * 1000,
    singleUse: true,
  });
}

async function opLinkStatus({ rt, cfg, body, reply }) {
  const token = String(body.token || body.link || '');
  const payload = await verifyToken(cfg.ADMIN_SIGNING_SECRET, token, { purpose: 'setup' });
  if (!payload) return reply({ ok: false, reason: 'invalid-or-expired' });
  const link = await AdminRepo.getLink(rt.store, payload.jti);
  if (!link) return reply({ ok: false, reason: 'not-found' });
  if (link.used) return reply({ ok: false, reason: 'already-used' });
  if (link.expiresAt <= now()) return reply({ ok: false, reason: 'expired' });
  const passkeys = await PasskeyRepo.list(rt.store);
  return reply({
    ok: true,
    purpose: link.purpose,
    expiresAt: link.expiresAt,
    rpId: cfg.ADMIN_RP_ID,
    rpName: cfg.ADMIN_RP_NAME,
    userVerification: cfg.ADMIN_USER_VERIFICATION,
    existingPasskeys: passkeys.length,
  });
}

async function ensureRpId({ cfg, request }) {
  const rpId = String(cfg.ADMIN_RP_ID || '');
  if (!rpId) throw new HttpError(RET.PARAM, '缺少配置项 ADMIN_RP_ID（Passkey 域名）');
  const host = new URL(resolveOrigin(request, cfg) || `https://${rpId}`).hostname;
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    // 允许本地开发例外
    if (host !== 'localhost' && host !== '127.0.0.1') {
      throw new HttpError(RET.PARAM, `当前访问域名 ${host} 与配置的 ADMIN_RP_ID ${rpId} 不匹配`);
    }
  }
  return rpId;
}

async function opRegisterOptions({ rt, cfg, body, request, reply, store }) {
  const link = await consumeLinkOnce(rt, cfg, body.token, ['setup', 'add-passkey']);
  const rpId = await ensureRpId({ cfg, request });
  const challenge = randomBytes(32);
  const challengeId = randomToken(12);
  await AdminRepo.putChallenge(rt.store, challengeId, {
    id: challengeId,
    challengeB64: b64url.encode(challenge),
    type: 'register',
    purpose: link.purpose,
    linkJti: link.jti,
    origin: resolveOrigin(request, cfg),
    rpId,
    createdAt: now(),
  }, Math.ceil((Number(cfg.ADMIN_TIMEOUT_MS) || 60000) / 1000) + 60);

  const existing = await PasskeyRepo.list(store);
  const options = buildRegistrationOptions({
    rpId,
    rpName: cfg.ADMIN_RP_NAME || 'WeChatBot Admin',
    userId: 'admin@local',
    userName: String(body.displayName || '管理员'),
    challenge,
    excludeCredentials: link.purpose === 'setup' ? [] : existing.map((c) => ({ id: c.id, transports: c.transports })),
    timeout: Number(cfg.ADMIN_TIMEOUT_MS) || 60000,
    userVerification: cfg.ADMIN_USER_VERIFICATION || 'preferred',
  });

  return reply({ options, challengeId });
}

async function opRegisterVerify({ rt, cfg, body, request, reply, store, log, ip }) {
  const state = await AdminRepo.takeChallenge(rt.store, String(body.challengeId || ''));
  if (!state || state.type !== 'register') throw new HttpError(RET.UNAUTHORIZED, '注册挑战无效或已过期，请重试', 401);

  const existing = await PasskeyRepo.list(store);
  let verified;
  try {
    verified = await verifyRegistration({
      credential: body.credential,
      expectedChallenge: b64url.decode(state.challengeB64),
      expectedOrigin: resolveOrigin(request, cfg) || state.origin,
      rpId: state.rpId,
      userVerification: cfg.ADMIN_USER_VERIFICATION || 'preferred',
      existingCredentialIds: existing.map((c) => c.id),
    });
  } catch (e) {
    if (e instanceof WebAuthnError) throw new HttpError(RET.UNAUTHORIZED, `密钥注册失败：${e.message}`, 401);
    throw e;
  }

  const credential = {
    id: verified.credentialId,
    publicKeyJwk: verified.publicKeyJwk,
    publicKeySpki: verified.publicKeySpki,
    algorithm: verified.algorithm,
    algorithmName: verified.algorithmName,
    signCount: verified.signCount,
    transports: verified.transports,
    aaguid: verified.aaguid,
    attestationFormat: verified.attestationFormat,
    displayName: String(body.displayName || '').slice(0, 40),
    createdAt: now(),
    lastUsedAt: 0,
    createdVia: state.purpose,
    revoked: false,
  };
  await PasskeyRepo.add(store, credential);

  // 首次注册完成 → 安全链接立即失效
  await AdminRepo.dropLink(rt.store, state.linkJti);
  await ConfigRepo.setSetup(rt.store, { initialized: true, initializedAt: now(), passkeyCount: existing.length + 1 });
  await AdminRepo.audit(rt.store, { action: 'passkey-register', credentialId: verified.credentialId, ip, via: state.purpose });
  log('info', 'admin:passkey-register', { credentialId: verified.credentialId, purpose: state.purpose });

  // 注册成功后直接签发管理端会话，用户可以立即开始配置
  return withAdminSession(rt, cfg, request, reply, {
    credentialId: verified.credentialId,
    passkeyCount: existing.length + 1,
    initialized: true,
  });
}

async function opAuthOptions({ rt, cfg, body, request, reply, store }) {
  const rpId = await ensureRpId({ cfg, request });
  const count = (await PasskeyRepo.list(store)).length;
  if (!count) throw new HttpError(RET.PARAM, '尚未注册任何密钥，请先通过临时安全链接进入并完成注册');

  const challenge = randomBytes(32);
  const challengeId = randomToken(12);
  await AdminRepo.putChallenge(rt.store, challengeId, {
    id: challengeId,
    challengeB64: b64url.encode(challenge),
    type: 'auth',
    rpId,
    origin: resolveOrigin(request, cfg),
    createdAt: now(),
  }, Math.ceil((Number(cfg.ADMIN_TIMEOUT_MS) || 60000) / 1000) + 60);

  // 默认不枚举凭证 ID，依赖可发现凭据（resident key）；body.enumerate=1 时可列出
  const allow = body.enumerate ? (await PasskeyRepo.list(store)).map((c) => ({ id: c.id, transports: c.transports })) : [];
  const options = buildAuthenticationOptions({
    rpId,
    challenge,
    allowCredentials: allow,
    timeout: Number(cfg.ADMIN_TIMEOUT_MS) || 60000,
    userVerification: cfg.ADMIN_USER_VERIFICATION || 'preferred',
  });
  return reply({ options, challengeId });
}

async function opAuthVerify({ rt, cfg, body, request, reply, store, log, ip }) {
  const wantReauth = String(body.purpose || '') === 'reauth';
  const state = await AdminRepo.takeChallenge(rt.store, String(body.challengeId || ''));
  if (!state || (state.type !== 'auth' && state.type !== 'reauth')) {
    throw new HttpError(RET.UNAUTHORIZED, '登录挑战无效或已过期，请重试', 401);
  }
  if (state.type === 'reauth' && !wantReauth) throw new HttpError(RET.UNAUTHORIZED, '该挑战用于敏感操作重新验证', 401);

  const identifier = String(body.credential?.id || body.credential?.rawId || '');
  const stored = await PasskeyRepo.find(store, identifier);
  if (!stored || stored.revoked) throw new HttpError(RET.UNAUTHORIZED, '未找到匹配的密钥', 401);

  let verified;
  try {
    verified = await verifyAuthentication({
      credential: body.credential,
      stored,
      expectedChallenge: b64url.decode(state.challengeB64),
      expectedOrigin: resolveOrigin(request, cfg) || state.origin,
      rpId: state.rpId,
      userVerification: cfg.ADMIN_USER_VERIFICATION || 'preferred',
    });
  } catch (e) {
    if (e instanceof WebAuthnError) throw new HttpError(RET.UNAUTHORIZED, `认证失败：${e.message}`, 401);
    throw e;
  }

  await PasskeyRepo.update(rt.store, stored.id, { signCount: verified.signCount, lastUsedAt: now() });

  if (wantReauth) {
    await AdminRepo.patchLink(rt.store, state.linkJti, { verified: true, verifiedAt: now(), credentialId: stored.id });
    const token = await issueToken(cfg.ADMIN_SIGNING_SECRET, { purpose: 'reauth', jti: state.linkJti, exp: now() + 300000 });
    await AdminRepo.audit(rt.store, { action: 'passkey-reauth', credentialId: stored.id, ip });
    log('info', 'admin:reauth', { credentialId: stored.id });
    return reply({ ok: true, reauthToken: token, expiresAt: now() + 300000 });
  }

  await AdminRepo.audit(rt.store, { action: 'passkey-login', credentialId: stored.id, ip });
  log('info', 'admin:login', { credentialId: stored.id });

  return withAdminSession(rt, cfg, request, reply, { credentialId: stored.id, userVerified: verified.userVerified });
}

/** 已登录状态下添加新密钥（走 reauth 挑战）。 */
/**
 * 敏感操作前的「重新验证」：下发认证挑战 + 一次性 reauth 令牌。
 * 客户端完成断言后调用 auth-verify(purpose=reauth)，服务端把令牌置为 verified。
 */
async function opReauthOptions({ rt, cfg, request, reply, store, ip }) {
  const rpId = await ensureRpId({ cfg, request });
  const count = (await PasskeyRepo.list(store)).length;
  if (!count) throw new HttpError(RET.PARAM, '尚未注册任何密钥');

  const ttl = 300;
  const jti = randomToken(16);
  await AdminRepo.putLink(rt.store, jti, {
    jti, purpose: 'reauth', used: false, verified: false,
    createdAt: now(), expiresAt: now() + ttl * 1000, ip,
  }, ttl);

  const challenge = randomBytes(32);
  const challengeId = randomToken(12);
  await AdminRepo.putChallenge(rt.store, challengeId, {
    id: challengeId,
    challengeB64: b64url.encode(challenge),
    type: 'reauth',
    linkJti: jti,
    rpId,
    origin: resolveOrigin(request, cfg),
    createdAt: now(),
  }, Math.ceil((Number(cfg.ADMIN_TIMEOUT_MS) || 60000) / 1000) + 60);

  const reauthToken = await issueToken(cfg.ADMIN_SIGNING_SECRET, { purpose: 'reauth', jti, exp: now() + ttl * 1000 });
  const options = buildAuthenticationOptions({
    rpId,
    challenge,
    allowCredentials: [],
    timeout: Number(cfg.ADMIN_TIMEOUT_MS) || 60000,
    userVerification: cfg.ADMIN_USER_VERIFICATION || 'preferred',
  });
  return reply({ options, challengeId, reauthToken, expiresAt: now() + ttl * 1000 });
}

/** 已登录状态下新增密钥：签发一次性 add-passkey 链接并下发注册选项。 */
async function opPasskeyAddOptions({ rt, cfg, body, request, reply, store, ip }) {
  const rpId = await ensureRpId({ cfg, request });
  const ttl = Number(cfg.SECURE_LINK_TTL_SECONDS) || 900;
  const jti = randomToken(16);
  await AdminRepo.putLink(rt.store, jti, {
    jti, purpose: 'add-passkey', used: false, verified: false,
    createdAt: now(), expiresAt: now() + ttl * 1000, ip, createdBy: 'admin-session',
  }, ttl);

  const challenge = randomBytes(32);
  const challengeId = randomToken(12);
  await AdminRepo.putChallenge(rt.store, challengeId, {
    id: challengeId,
    challengeB64: b64url.encode(challenge),
    type: 'register',
    purpose: 'add-passkey',
    linkJti: jti,
    rpId,
    origin: resolveOrigin(request, cfg),
    createdAt: now(),
  }, Math.ceil((Number(cfg.ADMIN_TIMEOUT_MS) || 60000) / 1000) + 60);

  const options = buildRegistrationOptions({
    rpId,
    rpName: cfg.ADMIN_RP_NAME || 'WeChatBot Admin',
    userId: 'admin@local',
    userName: String(body.displayName || '管理员'),
    challenge,
    excludeCredentials: (await PasskeyRepo.list(store)).map((c) => ({ id: c.id, transports: c.transports })),
    timeout: Number(cfg.ADMIN_TIMEOUT_MS) || 60000,
    userVerification: cfg.ADMIN_USER_VERIFICATION || 'preferred',
  });
  return reply({ options, challengeId });
}

/**
 * 校验一次性 reauth 令牌：必须由刚才那次 Passkey 断言把对应 link 标记为 verified。
 * 通过后立即销毁令牌，保证「一次断言只能放行一次敏感操作」。
 */
async function requireReauth(rt, rawToken) {
  const reauth = await verifyToken(rt.cfg.ADMIN_SIGNING_SECRET, String(rawToken || ''), { purpose: 'reauth' });
  if (!reauth) throw new HttpError(RET.UNAUTHORIZED, '该操作需要先完成一次 Passkey 验证', 401);
  const link = await AdminRepo.getLink(rt.store, reauth.jti);
  if (!link) throw new HttpError(RET.UNAUTHORIZED, '重新验证令牌不存在', 401);
  if (link.purpose !== 'reauth') throw new HttpError(RET.UNAUTHORIZED, '令牌用途不正确', 401);
  if (link.used) throw new HttpError(RET.UNAUTHORIZED, '该令牌已被使用', 401);
  if (!link.verified) throw new HttpError(RET.UNAUTHORIZED, '尚未完成 Passkey 断言，无法执行敏感操作', 401);
  if (link.expiresAt <= now()) throw new HttpError(RET.UNAUTHORIZED, '重新验证令牌已过期', 401);
  await AdminRepo.dropLink(rt.store, reauth.jti);
  return link;
}

async function consumeLinkOnce(rt, cfg, token, allowedPurposes) {
  const payload = await verifyToken(cfg.ADMIN_SIGNING_SECRET, String(token || ''), { purpose: 'setup' });
  if (!payload) throw new HttpError(RET.UNAUTHORIZED, '安全链接无效或已过期', 401);
  const link = await AdminRepo.getLink(rt.store, payload.jti);
  if (!link) throw new HttpError(RET.UNAUTHORIZED, '安全链接不存在（可能已被使用）', 401);
  if (link.used) throw new HttpError(RET.UNAUTHORIZED, '安全链接已被使用', 401);
  if (link.expiresAt <= now()) throw new HttpError(RET.UNAUTHORIZED, '安全链接已过期', 401);
  if (allowedPurposes && !allowedPurposes.includes(link.purpose)) {
    throw new HttpError(RET.FORBIDDEN, '该链接用途不匹配', 403);
  }
  return link;
}

async function withAdminSession(rt, cfg, request, reply, extra = {}) {
  const ttl = Number(cfg.ADMIN_SESSION_TTL_SECONDS) || 1800;
  const jti = randomToken(20);
  await AdminRepo.putSession(rt.store, jti, {
    jti,
    issuedAt: now(),
    expiresAt: now() + ttl * 1000,
    user: 'admin',
    ...extra,
  }, ttl);
  const token = await issueToken(cfg.ADMIN_SIGNING_SECRET, { purpose: 'admin', jti, exp: now() + ttl * 1000 });
  return reply(
    { ok: true, adminToken: token, expiresAt: now() + ttl * 1000, ...extra },
    200,
    { 'Set-Cookie': adminCookieAttrs(request, cfg, ttl).replace('%s', token) },
  );
}

async function opSessionState({ reply, session }) {
  return reply({ ok: true, expiresAt: session.expiresAt, issuedAt: session.issuedAt });
}

async function opLogout({ rt, reply, session, request }) {
  await AdminRepo.dropSession(rt.store, session.jti);
  return reply({ ok: true }, 200, { 'Set-Cookie': adminCookieAttrs(request, rt.cfg, 0).replace('%s', '') });
}

async function opConfigGet({ rt, body, reply }) {
  const reveal = String(body.reveal || '') === '1';
  if (reveal) {
    await requireReauth(rt, body.reauthToken);
  }
  return reply({
    ...serializeConfigForAdmin(rt.cfg, { revealSecrets: reveal }),
    validity: rt.validate(),
    overrides: Object.keys(rt.overrides || {}),
  });
}

async function opConfigSave({ rt, body, reply, log, ip, session }) {
  const nextOverrides = sanitizeOverrides(body.values || {}, rt.overrides || {});
  await ConfigRepo.setOverrides(rt.store, nextOverrides);

  // 重新构建并验证，避免写入非法值导致服务不可用
  const preview = buildConfig(rt.env, nextOverrides);
  const validity = validateConfig(preview);
  await AdminRepo.audit(rt.store, {
    action: 'config-save',
    keys: Object.keys(body.values || {}),
    ip,
    valid: validity.ok,
  });
  log('info', 'admin:config-save', { keys: Object.keys(body.values || {}), valid: validity.ok });

  return reply({
    ok: true,
    valid: validity.ok,
    missingRequired: validity.ok ? [] : validity.missing.map((m) => ({ key: m.key, label: m.label })),
    note: '配置已保存，立即对所有新请求生效（无需重新部署）',
  });
}

async function opPasskeysList({ rt, reply }) {
  const list = await PasskeyRepo.list(rt.store);
  return reply({
    passkeys: list.map((c) => ({
      id: c.id,
      displayName: c.displayName || '',
      algorithmName: c.algorithmName || '',
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt || 0,
      transports: c.transports || [],
      createdVia: c.createdVia || '',
      signCount: c.signCount || 0,
    })),
  });
}

async function opPasskeyRemove({ rt, cfg, body, reply, log, ip }) {
  if (cfg.ADMIN_STEP_UP_REAUTH !== false) await requireReauth(rt, body.reauthToken);
  const id = String(body.credentialId || '').trim();
  if (!id) throw new HttpError(RET.PARAM, '缺少 credentialId');
  const all = await PasskeyRepo.list(rt.store);
  if (all.length <= 1) {
    throw new HttpError(RET.FORBIDDEN, '至少需要保留一个密钥，删除后将无法登录管理端。请先添加新密钥。');
  }
  await PasskeyRepo.remove(rt.store, id);
  await AdminRepo.audit(rt.store, { action: 'passkey-remove', credentialId: id, ip });
  log('info', 'admin:passkey-remove', { credentialId: id });
  return reply({ ok: true, remaining: (await PasskeyRepo.list(rt.store)).length });
}

async function opResetPasskeys({ rt, body, request, reply, log, ip }) {
  // 高危操作：必须重新做一次 Passkey 断言（或在无密钥时用主密钥 + 重新签发链接）
  await requireReauth(rt, body.reauthToken);

  await PasskeyRepo.clear(rt.store);
  await ConfigRepo.setSetup(rt.store, { initialized: false, initializedAt: 0, resetAt: now() });
  // 吊销所有现有管理会话
  await AdminRepo.putSession(rt.store, '__revoked__', { revokedAt: now() }, 60);
  await AdminRepo.audit(rt.store, { action: 'reset-passkeys', ip });
  log('warn', 'admin:reset-passkeys', { ip });

  return reply({ ok: true, note: '已清空全部密钥，需使用主密钥重新签发安全链接进入配置' }, 200, {
    'Set-Cookie': adminCookieAttrs(request, rt.cfg, 0).replace('%s', ''),
  });
}

async function opILinkQrcode({ rt, reply, log }) {
  const res = await rt.ilink.requestQrCode([rt.cfg.ILINK_BOT_TOKEN].filter(Boolean));
  log('info', 'admin:ilink-qrcode');
  return reply({ qrcode: res.qrcode, qrcodeImg: res.qrcode_img_content });
}

async function opILinkQrstatus({ rt, body, reply, log }) {
  const status = await rt.ilink.pollQrStatus(String(body.qrcode || ''), body.verifyCode ? String(body.verifyCode) : undefined);
  if (status.status === 'confirmed' && status.bot_token) {
    // 自动写入运行环境覆盖值，无需手工粘贴
    const overrides = await ConfigRepo.getOverrides(rt.store);
    overrides.ILINK_BOT_TOKEN = status.bot_token;
    if (status.baseurl) overrides.ILINK_BASE_URL = status.baseurl;
    if (status.ilink_bot_id) overrides.ILINK_BOT_ID = status.ilink_bot_id;
    await ConfigRepo.setOverrides(rt.store, overrides);
    await AdminRepo.audit(rt.store, { action: 'ilink-login', botId: status.ilink_bot_id || '' });
    log('info', 'admin:ilink-login', { botId: status.ilink_bot_id || '' });
  }
  return reply({
    status: status.status,
    botTokenReceived: Boolean(status.bot_token),
    ilinkBotId: status.ilink_bot_id || '',
    baseurl: status.baseurl || '',
    needVerifyCode: status.status === 'need_verifycode',
    raw: status,
  });
}

async function opUsersList({ rt, body, reply }) {
  const limit = Math.min(200, Number(body.limit) || 50);
  const reg = (await getJson(rt.store, K.SWEEP_REGISTRY, {})) || {};
  const users = new Map();
  for (const key of Object.keys(reg)) {
    const userId = key.slice(0, key.indexOf('|'));
    if (!users.has(userId)) users.set(userId, { userId, activeSessions: 0, expiresAt: 0 });
    const u = users.get(userId);
    u.activeSessions++;
    u.expiresAt = Math.max(u.expiresAt, reg[key] || 0);
  }
  return reply({ users: [...users.values()].slice(0, limit) });
}

async function opSessionList({ rt, body, reply }) {
  const userId = String(body.userId || '');
  if (!userId) throw new HttpError(RET.PARAM, '缺少 userId');
  const index = await SessionRepo.getIndex(rt.store, userId);
  const sessions = [];
  for (const sid of index.recent || []) {
    const s = await SessionRepo.get(rt.store, userId, sid);
    if (s) {
      sessions.push({
        sessionId: s.sessionId, state: s.state, turn: s.turn, createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt, expiresAt: s.expiresAt, endReason: s.endReason,
        messageCount: s.messageCount, memoryInjectIds: s.memoryInjectIds?.length || 0,
      });
    }
  }
  return reply({ userId, ...index, sessions });
}

async function opSessionEnd({ rt, body, reply, log }) {
  const userId = String(body.userId || '');
  if (!userId) throw new HttpError(RET.PARAM, '缺少 userId');
  let sessionId = String(body.sessionId || '');
  if (!sessionId) sessionId = (await rt.services.sessions.status(userId)).activeSessionId || '';
  if (!sessionId) return reply({ ended: false, reason: 'no_active_session' });
  const out = await rt.services.sessions.endSession({ userId, sessionId, reason: 'admin', by: 'admin' });
  log('info', 'admin:session-end', { userId, sessionId });
  return reply({ ended: true, sessionId, memoriesSaved: out.memories.map((m) => ({ id: m.id, content: m.content })) });
}

async function opMemoryList({ rt, body, reply }) {
  const userId = String(body.userId || '');
  if (!userId) throw new HttpError(RET.PARAM, '缺少 userId');
  const items = await rt.services.memoryEngine.query({
    userId,
    query: String(body.query || ''),
    limit: Math.min(200, Number(body.limit) || 50),
  });
  const stats = await rt.services.memoryEngine.stats(userId);
  return reply({ userId, items, stats });
}

async function opMemoryDelete({ rt, body, reply, log }) {
  const userId = String(body.userId || '');
  const id = String(body.memoryId || '');
  if (!userId || !id) throw new HttpError(RET.PARAM, '缺少 userId 或 memoryId');
  const removed = await rt.services.memoryEngine.remove(userId, id);
  log('info', 'admin:memory-delete', { userId, id, removed });
  return reply({ ok: removed });
}

async function opMemoryPurge({ rt, body, reply, log }) {
  const userId = String(body.userId || '');
  if (!userId) throw new HttpError(RET.PARAM, '缺少 userId');
  await rt.services.memoryEngine.purge(userId);
  log('warn', 'admin:memory-purge', { userId });
  return reply({ ok: true });
}

async function opSweep({ rt, body, reply }) {
  const out = await rt.services.sessions.sweep(Math.min(200, Number(body.limit) || 50));
  return reply(out);
}

async function opAuditList({ rt, body, reply }) {
  const list = await AdminRepo.recentAudit(rt.store, Math.min(200, Number(body.limit) || 50));
  return reply({ items: list });
}

// ── 响应构造 ────────────────────────────────────────────────────────────

function json(payload, status = 200, origin = '*', extraHeaders = {}, credentials = false) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(origin !== '*' ? corsHeaders(origin, credentials) : {}),
    ...extraHeaders,
  };
  return new Response(JSON.stringify(payload), { status, headers });
}
