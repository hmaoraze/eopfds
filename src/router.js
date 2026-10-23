/**
 * HTTP 路由层。所有函数入口都只是转调这里，方便把整条链路放进单测。
 *
 * 约定：
 * - 业务路由（/session/*）在进入前先 assertChatReady：必填配置缺失一律 503，不降级运行。
 * - 管理路由（/admin/*）独立鉴权，且响应体不含任何明文凭据。
 * - 定时任务路由用独立的 CRON_SECRET，不复用管理凭据（职责分离，泄漏面更小）。
 */

import { AppError, ErrorCodes } from './errors.js';
import { jsonResponse, errorResponse, createBodyReader } from './http.js';
import { randomToken, timingSafeEqual } from './crypto-utils.js';
import {
  loadConfig,
  assertChatReady,
  assertAdminReady,
  assertBlobReady,
  buildConfigStatus,
} from './config.js';
import { createRepo, resolveStore } from './blob.js';
import { createChatService } from './chat-service.js';
import { createWechatGateway } from './wechat.js';
import { verifyAdminRequest, verifyCronRequest } from './auth.js';
import { assertSessionId, assertUserId } from './session-service.js';

function normalizePath(pathname) {
  let p = pathname.replace(/\/+$/, '');
  if (p === '') return '/';
  if (p === '/api') return '/';
  if (p.startsWith('/api/')) p = p.slice(4);
  return p;
}

const ROUTES = [
  { method: 'GET', path: '/', handler: 'health' },
  { method: 'GET', path: '/health', handler: 'health' },

  { method: 'POST', path: '/session/create', handler: 'sessionCreate' },
  { method: 'POST', path: '/session/resume', handler: 'sessionResume' },
  // 会话 id 统一以 s_ 开头（newSessionId 生成），正则带前缀可避免 /session/create 被当成 sessionId
  { method: 'POST', path: /^\/session\/(s_[A-Za-z0-9_-]{4,62})\/message$/, handler: 'sessionMessage', params: ['sessionId'] },
  { method: 'POST', path: /^\/session\/(s_[A-Za-z0-9_-]{4,62})\/end$/, handler: 'sessionEnd', params: ['sessionId'] },
  { method: 'GET', path: /^\/session\/(s_[A-Za-z0-9_-]{4,62})\/history$/, handler: 'sessionHistory', params: ['sessionId'] },
  { method: 'GET', path: /^\/session\/(s_[A-Za-z0-9_-]{4,62})$/, handler: 'sessionStatus', params: ['sessionId'] },

  { method: 'GET', path: '/admin/config/status', handler: 'adminConfigStatus' },
  { method: 'GET', path: /^\/admin\/memory\/([A-Za-z0-9_-]{1,64})$/, handler: 'adminMemory', params: ['userId'] },
  { method: 'POST', path: '/admin/maintenance/sweep', handler: 'adminSweep' },

  { method: 'POST', path: '/wechat/webhook', handler: 'wechatWebhook' },
  { method: 'POST', path: '/wechat/poll', handler: 'wechatPoll' },
];

function matchRoute(method, path) {
  let pathMatched = false;
  for (const route of ROUTES) {
    let params = null;
    if (typeof route.path === 'string') {
      if (route.path !== path) continue;
      params = {};
    } else {
      const m = route.path.exec(path);
      if (!m) continue;
      params = {};
      (route.params ?? []).forEach((name, index) => {
        params[name] = m[index + 1];
      });
    }
    pathMatched = true;
    if (route.method !== method) continue;
    return { handler: route.handler, params, methodNotAllowed: false };
  }
  return pathMatched ? { methodNotAllowed: true } : null;
}

function requireQueryUserId(url) {
  const userId = url.searchParams.get('userId') ?? '';
  if (!userId) {
    throw new AppError(ErrorCodes.BAD_REQUEST, '缺少 userId 查询参数', 400, { field: 'userId' });
  }
  return assertUserId(userId);
}

async function assertWechatSecret(request, cfg) {
  if (!cfg.wechatbotWebhookSecret) {
    throw new AppError(ErrorCodes.CONFIG_MISSING, '微信回调密钥未配置', 503, {
      requiredMissing: ['WECHATBOT_WEBHOOK_SECRET'],
    });
  }
  const provided = request.headers.get('x-wechatbot-secret') ?? '';
  if (!(await timingSafeEqual(provided, cfg.wechatbotWebhookSecret))) {
    throw new AppError(ErrorCodes.UNAUTHORIZED, '微信回调鉴权未通过', 401, { reason: 'bad_webhook_secret' });
  }
}

export async function handleRequest(context, deps = {}) {
  const request = context?.request ?? context;
  const env = context?.env ?? {};
  const waitUntil = context?.waitUntil ?? deps.waitUntil;
  const clock = deps.clock ?? { now: () => Date.now() };
  const requestId = randomToken(6);

  if (!request || typeof request !== 'object') {
    return jsonResponse({ error: { code: ErrorCodes.BAD_REQUEST, message: '缺少 request 对象' } }, { status: 400 });
  }

  const url = new URL(request.url ?? 'http://localhost/');
  const pathname = url.pathname;
  const path = normalizePath(pathname);
  const method = String(request.method ?? 'GET').toUpperCase();

  try {
    const cfg = loadConfig(env);
    const matched = matchRoute(method, path);
    if (!matched) {
      throw new AppError(ErrorCodes.NOT_FOUND, `未知路由 ${method} ${pathname}`, 404);
    }
    if (matched.methodNotAllowed) {
      throw new AppError(ErrorCodes.METHOD_NOT_ALLOWED, `${path} 不支持 ${method}`, 405);
    }

    const body = createBodyReader(request);
    // 惰性初始化：health / 鉴权失败等路径不应触发 Blob 连接，
    // 否则一个缺配置的部署会在每个请求里留下一条未处理的 Promise 拒绝。
    let repoPromise = null;
    const getRepo = () => {
      if (!repoPromise) {
        repoPromise = (async () => {
          assertBlobReady(cfg);
          return createRepo(await resolveStore(cfg, deps.store));
        })();
      }
      return repoPromise;
    };

    let chatPromise = null;
    const getChat = () => {
      if (!chatPromise) {
        chatPromise = getRepo().then(
          (repo) => createChatService({ cfg, repo, clock, fetchImpl: deps.fetchImpl, waitUntil }),
        );
      }
      return chatPromise;
    };

    const ctx = {
      request,
      url,
      cfg,
      clock,
      deps,
      requestId,
      method,
      pathname,
      params: matched.params ?? {},
      body,
      getRepo,
      getChat,
      waitUntil,
    };

    const handler = HANDLERS[matched.handler];
    if (!handler) throw new AppError(ErrorCodes.INTERNAL_ERROR, `路由处理器缺失: ${matched.handler}`, 500);
    return await handler(ctx);
  } catch (err) {
    return errorResponse(err, requestId);
  }
}

const HANDLERS = {
  async health({ cfg, clock }) {
    return jsonResponse({
      ok: true,
      service: 'edgeone-makers-chat',
      time: clock.now(),
      configured: cfg.requiredMissing.length === 0 && cfg.invalidEntries.length === 0,
      requiredMissing: cfg.requiredMissing,
      promptInjectionMode: cfg.promptInjectionMode,
      memoryToolEnabled: cfg.memoryToolEnabled,
    });
  },

  async sessionCreate({ cfg, body, getChat }) {
    assertChatReady(cfg);
    const payload = await body.json();
    const userId = assertUserId(payload.userId ?? '');
    const chat = await getChat();
    const session = await chat.createSession({
      userId,
      source: 'api',
      metadata: typeof payload.metadata === 'object' && payload.metadata ? payload.metadata : {},
    });
    return jsonResponse(session, { status: 201 });
  },

  async sessionResume({ cfg, body, getChat }) {
    assertChatReady(cfg);
    const payload = await body.json();
    const userId = assertUserId(payload.userId ?? '');
    const chat = await getChat();
    const { created, session } = await chat.resumeOrCreate({ userId, source: 'api' });
    return jsonResponse({ created, session }, { status: created ? 201 : 200 });
  },

  async sessionMessage({ cfg, params, body, getChat }) {
    assertChatReady(cfg);
    const sessionId = assertSessionId(params.sessionId);
    const payload = await body.json();
    const userId = assertUserId(payload.userId ?? '');
    const chat = await getChat();
    const result = await chat.sendMessage({ userId, sessionId, text: payload.text });
    return jsonResponse(result);
  },

  async sessionEnd({ cfg, params, body, getChat }) {
    assertChatReady(cfg);
    const sessionId = assertSessionId(params.sessionId);
    const payload = await body.json();
    const userId = assertUserId(payload.userId ?? '');
    const chat = await getChat();
    return jsonResponse(await chat.endSession({ userId, sessionId }));
  },

  async sessionStatus({ cfg, params, url, getChat }) {
    assertChatReady(cfg);
    const sessionId = assertSessionId(params.sessionId);
    const userId = requireQueryUserId(url);
    const chat = await getChat();
    return jsonResponse(await chat.getStatus({ userId, sessionId }));
  },

  async sessionHistory({ cfg, params, url, getChat }) {
    assertChatReady(cfg);
    const sessionId = assertSessionId(params.sessionId);
    const userId = requireQueryUserId(url);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const chat = await getChat();
    return jsonResponse(await chat.getHistory({
      userId,
      sessionId,
      limit: Number.isFinite(limit) ? limit : 50,
    }));
  },

  async adminConfigStatus({ request, cfg, url, body, method, pathname, getRepo }) {
    assertAdminReady(cfg);
    await verifyAdminRequest({
      request,
      cfg,
      method,
      path: pathname,
      rawBody: method === 'GET' ? '' : await body.raw(),
    });
    const status = await buildConfigStatus(cfg);

    if (url.searchParams.get('stats') === '1') {
      const repo = await getRepo();
      const sessionKeys = await repo.listKeys('sessions/', { limit: 500 });
      const memoryKeys = await repo.listKeys('memories/', { limit: 500 });
      status.stats = { sessionFiles: sessionKeys.length, memoryFiles: memoryKeys.length };
    }
    return jsonResponse(status);
  },

  async adminMemory({ request, cfg, params, body, method, pathname, getChat }) {
    assertAdminReady(cfg);
    await verifyAdminRequest({
      request,
      cfg,
      method,
      path: pathname,
      rawBody: method === 'GET' ? '' : await body.raw(),
    });
    const userId = assertUserId(params.userId);
    const chat = await getChat();
    return jsonResponse({ userId, ...(await chat.memoryStats(userId)) });
  },

  async adminSweep({ request, cfg, body, method, pathname, getChat }) {
    assertAdminReady(cfg);
    const rawBody = await body.raw();
    await verifyAdminRequest({ request, cfg, method, path: pathname, rawBody });
    const payload = await body.json();
    const chat = await getChat();
    if (payload.userId) {
      const userId = assertUserId(payload.userId);
      return jsonResponse({ mode: 'single', result: await chat.sweepUser(userId) });
    }
    return jsonResponse({ mode: 'all', result: await chat.sweepAll() });
  },

  async wechatWebhook({ request, cfg, body, getChat, getRepo, clock, deps }) {
    assertChatReady(cfg);
    await assertWechatSecret(request, cfg);
    const payload = await body.json();
    const gateway = createWechatGateway({
      cfg,
      chatService: await getChat(),
      repo: await getRepo(),
      clock,
      fetchImpl: deps.fetchImpl,
    });
    const result = await gateway.handleWebhook(payload);
    return jsonResponse({ ok: true, ...result });
  },

  async wechatPoll({ request, cfg, url, body, getChat, getRepo, clock, deps }) {
    assertChatReady(cfg);
    // 先读 body：平台内置 schedules 无法自定义请求头，凭据可能放在 payload.token
    const payload = await body.json().catch(() => ({}));
    await verifyCronRequest({ request, cfg, url, payload });
    // 允许 body 覆盖单次处理上限，便于排障时小批量试跑
    const gateway = createWechatGateway({
      cfg,
      chatService: await getChat(),
      repo: await getRepo(),
      clock,
      fetchImpl: deps.fetchImpl,
    });
    const stats = await gateway.pollOnce({
      maxMessages: Number(payload.maxMessages ?? 10) || 10,
      timeBudgetMs: Number(payload.timeBudgetMs ?? 20000) || 20000,
    });
    return jsonResponse({ ok: true, ...stats });
  },
};
