/**
 * 定时任务 / 运维端点。
 *
 *GET /api/cron?op=sweep        超时会话回收（提炼记忆 + 释放登记）
 * GET /api/cron?op=poll         单次驱动 iLink getupdates（需开启 ILINK_SELF_POLL）
 * GET /api/cron?op=summary      刷新指定用户的记忆摘要
 *
 * 鉴权：Header X-Admin-Master-Key 或 X-Cron-Token（环境变量 CRON_TOKEN，可选）
 */

import { createRuntime } from '../index.js';
import { readJson, HttpError, toErrorResponse, corsHeaders, RET } from '../lib/http.js';
import { ILinkRepo, AdminRepo } from '../repository.js';
import { parseIncoming } from '../ilink.js';
import { safeCompare, now } from '../lib/util.js';

export async function handleCronRequest(context) {
  const request = context.request;
  let rt;
  try {
    rt = await createRuntime(context);
  } catch (e) {
    return json({ ret: RET.UPSTREAM, errmsg: `初始化失败：${e.message}` }, 500);
  }
  const { cfg, store, log } = rt;
  const cors = corsHeaders(cfg.CORS_ALLOW_ORIGIN || '*');

  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'POST') throw new HttpError(RET.PARAM, '仅支持 GET/POST', 405);

    const url = new URL(request.url);
    const body = request.method === 'POST' ? await readJson(request).catch(() => ({})) : {};
    const op = String(body.op || url.searchParams.get('op') || 'sweep');

    // ── 鉴权 ─────────────────────────────────────────────────────────
    const masterKey = request.headers.get('X-Admin-Master-Key') || '';
    const cronToken = request.headers.get('X-Cron-Token') || String(url.searchParams.get('token') || '');
    const expectedToken = String(rt.env.CRON_TOKEN || '');
    const okMaster = masterKey ? await safeCompare(cfg.ADMIN_MASTER_KEY, masterKey) : false;
    const okCron = expectedToken && cronToken ? await safeCompare(expectedToken, cronToken) : false;
    if (!okMaster && !okCron) throw new HttpError(RET.UNAUTHORIZED, '缺少或错误的鉴权凭证', 401);

    switch (op) {
      case 'sweep': {
        const out = await rt.services.sessions.sweep(Math.min(500, Number(url.searchParams.get('limit')) || 100));
        return json({ ret: RET.OK, op, ...out }, 200);
      }

      case 'poll': {
        if (cfg.ILINK_SELF_POLL !== true) throw new HttpError(RET.FORBIDDEN, '未开启 ILINK_SELF_POLL');
        if (!rt.ilink.configured) throw new HttpError(RET.PARAM, '缺少 ILINK_BOT_TOKEN');
        const cursor = await ILinkRepo.getCursor(store);
        const updates = await rt.ilink.getUpdates(cursor, 40000);
        if (typeof updates.get_updates_buf === 'string') {
          await ILinkRepo.setCursor(store, updates.get_updates_buf);
        }
        const processed = [];
        for (const wire of updates.msgs || []) {
          const event = parseIncoming(wire);
          if (!event.isUser || !event.userId || !event.text) continue;
          if (await ILinkRepo.seen(store, `${event.userId}:${event.messageId || event.clientId || event.timestamp}`)) continue;
          const result = await rt.services.conversation.handleTurn({
            userId: event.userId,
            text: event.text,
            contextToken: event.contextToken,
            wire,
          });
          if (result.skipped) continue;
          for (const msg of result.sendMessages) {
            await rt.ilink.sendMessage(msg).catch(() => null);
          }
          processed.push({ userId: event.userId, sessionId: result.sessionId, turn: result.turn });
        }
        await AdminRepo.audit(store, { action: 'cron:poll', count: processed.length });
        return json({ ret: RET.OK, op, cursor: updates.get_updates_buf || '', processed: processed.length, details: processed }, 200);
      }

      case 'summary': {
        const userId = String(body.userId || url.searchParams.get('userId') || '');
        if (!userId) throw new HttpError(RET.PARAM, '缺少 userId');
        const digest = await rt.services.summarizer.buildMemoryDigest({ userId, force: true });
        return json({ ret: RET.OK, op, userId, source: digest.source, text: digest.text, size: digest.ids.length }, 200);
      }

      default:
        throw new HttpError(RET.PARAM, `未知操作 ${op}`);
    }
  } catch (error) {
    log('error', 'cron:error', { message: error?.message });
    const res = toErrorResponse(error);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Timestamp': String(now()) },
  });
}
