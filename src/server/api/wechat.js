/**
 * 统一会话接口。
 *
 * POST /api/wechat
 *   单条：{ action, userId, text, sessionId?, contextToken?, forceNew?, deliver? }
 *   iLink 原生：{ action:"ingest", updates: GetUpdatesResponse } 或 { wire: WireMessage }
 *   批量：{ action:"send_batch", items:[{userId,text,...}] }
 *
 * GET  /api/wechat?userId=xxx              → 会话状态
 * DELETE /api/wechat?userId=xxx&sessionId= → 显式结束
 *
 * 统一响应：{ ret, errmsg?, sessionId, state, turn, expiresAt, reply, sendMessages, memoriesSaved, usage, ... }
 */

import { createRuntime } from '../index.js';
import { ok, fail, readJson, HttpError, toErrorResponse, corsHeaders, preflight, rateLimit, RET } from '../lib/http.js';
import { parseIncoming } from '../ilink.js';
import { ILinkRepo, K } from '../repository.js';
import { detectInjectionAttempt } from '../prompt.js';
import { now } from '../lib/util.js';

function withCors(cfg, request) {
  const origin = cfg.CORS_ALLOW_ORIGIN === '*' ? '*' : String(cfg.CORS_ALLOW_ORIGIN || '*');
  return corsHeaders(origin, false);
}

async function maybeDeliver({ rt, result, userId, contextToken }) {
  const cfg = rt.cfg;
  const delivered = [];
  if (!result.deliver || !rt.ilink.configured) {
    return { delivered, skipped: true };
  }
  let ticket = '';
  try {
    if (cfg.ILINK_TYPING !== false) {
      ticket = await ILinkRepo.getTicket(rt.store, userId);
      if (!ticket) {
        const got = await rt.ilink.getConfig(userId, contextToken).catch(() => null);
        ticket = got?.typing_ticket || '';
        if (ticket) await ILinkRepo.rememberTicket(rt.store, userId, ticket);
      }
      if (ticket) await rt.ilink.sendTyping(userId, ticket, 1).catch(() => {});
    }
  } catch { /* 输入状态失败不影响发送 */ }

  for (const msg of result.sendMessages) {
    const r = await rt.ilink.sendMessage(msg).catch((e) => ({ error: e.message }));
    delivered.push(r);
  }

  try {
    if (cfg.ILINK_TYPING !== false && ticket) await rt.ilink.sendTyping(userId, ticket, 2).catch(() => {});
  } catch { /* noop */ }
  return { delivered, skipped: false };
}

export async function handleWechatRequest(context) {
  const request = context.request;
  let rt;
  try {
    rt = await createRuntime(context);
  } catch (e) {
    return fail(RET.UPSTREAM, `初始化失败：${e.message}`);
  }
  const { cfg, log } = rt;
  const cors = withCors(cfg, request);
  const respond = (payload, status = 200) =>
    new Response(JSON.stringify({ ret: RET.OK, ...payload }), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
    });

  try {
    const validity = rt.validate();
    if (!validity.ok) {
      const list = validity.missing.map((m) => m.key).join(', ');
      return fail(RET.PARAM, `缺少必填配置项：${list}。请先在管理端完成配置。`, { headers: cors });
    }
    if (request.method === 'OPTIONS') return preflight(cfg.CORS_ALLOW_ORIGIN === '*' ? '*' : cfg.CORS_ALLOW_ORIGIN);
    if (request.method === 'GET') return respond(await handleGet(rt, new URL(request.url).searchParams));
    if (request.method === 'DELETE') return respond(await handleDelete(rt, new URL(request.url).searchParams));
    if (request.method !== 'POST') throw new HttpError(RET.PARAM, '仅支持 GET/POST/DELETE', 405);

    const body = await readJson(request);
    const action = String(body.action || 'send');

    // ── iLink 长轮询结果批量接入 ──────────────────────────────────────
    if (action === 'ingest' || Array.isArray(body.msgs) || Array.isArray(body.updates)) {
      const updates = Array.isArray(body.updates) ? body.updates : body.updates?.msgs || body.msgs || [];
      const results = [];
      for (const wire of updates.slice(0, 20)) {
        const event = parseIncoming(wire);
        if (!event.userId || !event.text) continue;
        if (!event.isUser) continue;
        if (await ILinkRepo.seen(rt.store, `${event.userId}:${event.messageId || event.clientId || event.timestamp}`)) continue;
        const item = await rt.services.conversation.handleTurn({
          userId: event.userId,
          text: event.text,
          contextToken: event.contextToken,
          wire,
          deliver: body.deliver,
        });
        if (item.skipped) continue;
        const delivery = await maybeDeliver({ rt, result: item, userId: event.userId, contextToken: event.contextToken });
        results.push({ ...publicize(item), delivered: delivery.delivered.length });
      }
      return respond({ count: results.length, results });
    }

    // ── 批量 ────────────────────────────────────────────────────────
    if (action === 'send_batch') {
      const items = Array.isArray(body.items) ? body.items.slice(0, 10) : [];
      const results = [];
      for (const item of items) {
        const r = await rt.services.conversation.handleTurn(normalizeInput(item, cfg));
        if (r.skipped) continue;
        await maybeDeliver({ rt, result: r, userId: r.userId, contextToken: r.contextToken });
        results.push(publicize(r));
      }
      return respond({ count: results.length, results });
    }

    // ── 单条 wire 透传 ──────────────────────────────────────────────
    if (body.wire && !body.text) {
      const event = parseIncoming(body.wire);
      if (!event.text) return respond({ skipped: true, reason: 'empty_or_unsupported' });
      if (await ILinkRepo.seen(rt.store, `${event.userId}:${event.messageId || event.clientId || event.timestamp}`)) {
        return respond({ skipped: true, reason: 'duplicate' });
      }
      const result = await rt.services.conversation.handleTurn({
        userId: event.userId,
        text: event.text,
        contextToken: event.contextToken,
        wire: body.wire,
        sessionId: body.sessionId,
        deliver: body.deliver,
      });
      const delivery = await maybeDeliver({ rt, result, userId: event.userId, contextToken: event.contextToken });
      return respond({ ...publicize(result), delivered: !delivery.skipped });
    }

    // ── 单条标准输入 ────────────────────────────────────────────────
    if (action === 'start') {
      const session = await rt.services.sessions.create({
        userId: String(body.userId || ''),
        contextToken: body.contextToken,
      });
      return respond({
        sessionId: session.sessionId,
        state: session.state,
        expiresAt: session.expiresAt,
        memoryDigest: session.memoryDigest,
        memoryInjectIds: session.memoryInjectIds,
      });
    }

    const input = normalizeInput(body, cfg);
    if (!input.userId) throw new HttpError(RET.PARAM, '缺少 userId');
    if (!String(input.text || '').trim() && action !== 'status') {
      throw new HttpError(RET.PARAM, '缺少 text');
    }

    // 限流
    const limited = !(await rateLimit(rt.store, `${K.rate('chat', Math.floor(now() / 60000), input.userId)}`, Number(cfg.CHAT_RATE_LIMIT) || 60, 60000));
    if (limited) throw new HttpError(RET.RATE_LIMITED, '请求过于频繁，请稍后再试');

    if (context.waitUntil) {
      // 预留：把后台提炼放到事件生命周期之外（超时回收由 /api/cron 承担）
    }
    const result = await rt.services.conversation.handleTurn(input);
    if (result.skipped) return respond({ skipped: true, reason: result.reason, warnings: result.warnings });

    const delivery = await maybeDeliver({ rt, result, userId: result.userId, contextToken: result.contextToken });
    log('info', 'wechat:turn', {
      userId: result.userId,
      sessionId: result.sessionId,
      turn: result.turn,
      created: result.created,
      memories: result.memoriesSaved.length,
      latencyMs: result.latencyMs,
    });
    return respond({ ...publicize(result), delivered: !delivery.skipped && delivery.delivered.length > 0 });
  } catch (error) {
    log('error', 'wechat:error', { message: error?.message });
    const res = toErrorResponse(error);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
}

async function handleGet(rt, params) {
  const userId = String(params.get('userId') || '');
  if (!userId) throw new HttpError(RET.PARAM, '缺少 userId');
  const status = await rt.services.sessions.status(userId);
  const memories = params.get('withMemories') ? await rt.services.memoryEngine.query({ userId, limit: 20 }) : undefined;
  return { userId, ...status, memories };
}

async function handleDelete(rt, params) {
  const userId = String(params.get('userId') || '');
  if (!userId) throw new HttpError(RET.PARAM, '缺少 userId');
  let sessionId = String(params.get('sessionId') || '');
  if (!sessionId) sessionId = (await rt.services.sessions.status(userId)).activeSessionId || '';
  if (!sessionId) return { ended: false, reason: 'no_active_session' };
  const out = await rt.services.sessions.endSession({ userId, sessionId, reason: 'api-delete', by: 'user' });
  return { ended: true, sessionId, memoriesSaved: out.memories.map((m) => ({ id: m.id, content: m.content })) };
}

function normalizeInput(body, cfg) {
  return {
    injectionHits: detectInjectionAttempt(body), // 原始请求体里出现的受保护字段
    userId: String(body.userId || ''),
    text: String(body.text ?? ''),
    sessionId: body.sessionId ? String(body.sessionId) : '',
    contextToken: body.contextToken ? String(body.contextToken) : '',
    forceNew: Boolean(body.forceNew),
    messageId: body.messageId ? String(body.messageId) : '',
    deliver: body.deliver === undefined ? undefined : Boolean(body.deliver),
    maxChars: Number(body.maxChars) || undefined,
  };
}

function publicize(r) {
  return {
    sessionId: r.sessionId,
    userId: r.userId,
    state: r.state,
    turn: r.turn,
    created: r.created,
    previousEnded: r.previousEnded,
    expiresAt: r.expiresAt,
    reply: r.replyText,
    chunks: r.chunks,
    sendMessages: r.sendMessages,
    contextToken: r.contextToken,
    memoriesSaved: r.memoriesSaved,
    toolTrace: r.toolTrace,
    usage: r.usage,
    warnings: r.warnings,
    deliver: r.deliver,
    latencyMs: r.latencyMs,
  };
}

export { publicize };
