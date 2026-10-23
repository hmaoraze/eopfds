/**
 * wechatbot.dev iLink 协议适配层。
 *
 * 协议要点（A6）：
 * - 接收：POST {base}/ilink/bot/getupdates，带上翻页游标（get_updates_buf），长轮询拉取。
 * - 发送：POST {base}/ilink/bot/sendmessage，payload 必须原样携带入站消息的 context_token，
 *   否则消息路由不到对应的微信会话窗口。缺失 context_token 时本层直接拒绝发送，
 *   而不是「发出去赌一把」——发错窗口的代价远高于不回。
 *
 * 端点路径与字段名做成了配置项 + 归一化函数：不同租户的 iLink 网关版本存在字段差异
 * （text / content / item_list[0].text_item.text 都见过），把差异收敛在这一个文件里，
 * 上层逻辑不感知。部署时按你的租户实际报文核对 normalizeInbound 即可，不需要改业务代码。
 */

import { AppError, ErrorCodes } from './errors.js';
import { withLock } from './lock.js';

const CURSOR_KEY = 'cursors/wechat/cursor.json';
const CURSOR_LOCK = 'locks/wechat/cursor.json';
const RECENT_ID_LIMIT = 50;

function firstString(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

/** 把不同网关版本的入站报文归一成 {userId, text, contextToken, messageId}。 */
export function normalizeInbound(raw) {
  const msg = raw?.msg && typeof raw.msg === 'object' ? raw.msg : raw;
  const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
  const textItem = items.find((item) => item && (item.text_item || item.type === 1)) ?? items[0];

  return {
    userId: firstString(
      msg?.from_user_name,
      msg?.fromUser,
      msg?.from,
      msg?.sender,
      msg?.user_id,
      raw?.from_user_name,
    ),
    text: firstString(
      msg?.text,
      msg?.content,
      textItem?.text_item?.text,
      textItem?.text,
      raw?.text,
    ),
    contextToken: firstString(msg?.context_token, msg?.contextToken, raw?.context_token),
    messageId: firstString(msg?.msg_id, msg?.message_id, msg?.id, raw?.msg_id),
    rawType: msg?.type ?? msg?.msg_type ?? null,
  };
}

export function createWechatClient(cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  function authHeaders() {
    const headers = { 'content-type': 'application/json' };
    if (cfg.wechatbotToken) headers.authorization = `Bearer ${cfg.wechatbotToken}`;
    return headers;
  }

  async function post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.wechatbotPollTimeoutMs + 5000);
    let response;
    try {
      response = await fetchImpl(`${cfg.wechatbotBaseUrl}${path}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new AppError(ErrorCodes.WECHAT_ERROR, '微信网关请求失败', 502, {
        path,
        timedOut: err?.name === 'AbortError',
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AppError(ErrorCodes.WECHAT_ERROR, `微信网关返回 ${response.status}`, 502, {
        path,
        upstreamStatus: response.status,
        upstreamBody: String(text).slice(0, 200),
      });
    }
    try {
      return await response.json();
    } catch {
      throw new AppError(ErrorCodes.WECHAT_ERROR, '微信网关响应不是合法 JSON', 502, { path });
    }
  }

  /**
   * 长轮询拉取。timeout 由网关侧持有连接，函数侧只受自身执行时长限制，
   * 所以这里默认 10 秒，配合外部定时器 30 秒触发一次即可覆盖。
   */
  async function getUpdates({ cursor = '', timeoutMs = cfg.wechatbotPollTimeoutMs } = {}) {
    const payload = {
      token: cfg.wechatbotToken,
      get_updates_buf: cursor,
      timeout: Math.max(1, Math.floor(timeoutMs / 1000)),
    };
    const data = await post(cfg.wechatbotGetUpdatesPath, payload);
    const messages = Array.isArray(data?.msgs)
      ? data.msgs
      : (Array.isArray(data?.messages) ? data.messages : (Array.isArray(data?.data) ? data.data : []));
    return {
      cursor: firstString(data?.get_updates_buf, data?.cursor, cursor),
      messages,
      ret: data?.ret ?? 0,
    };
  }

  async function sendText({ toUser, contextToken, text }) {
    if (!contextToken) {
      // A6 的强制点：没有 context_token 一律不发
      throw new AppError(ErrorCodes.WECHAT_ERROR, '缺少 context_token，拒绝发送（无法确定目标会话）', 400, {
        reason: 'missing_context_token',
      });
    }
    if (!toUser) {
      throw new AppError(ErrorCodes.WECHAT_ERROR, '缺少接收方标识，拒绝发送', 400, { reason: 'missing_to_user' });
    }
    const payload = {
      token: cfg.wechatbotToken,
      msg: {
        to_user_name: toUser,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text: String(text ?? '').slice(0, 4000) } }],
      },
    };
    const data = await post(cfg.wechatbotSendPath, payload);
    return { ok: true, ret: data?.ret ?? 0, contextTokenUsed: true };
  }

  return { getUpdates, sendText };
}

/**
 * 网关编排：入站 → 会话 → 上游 → 带 context_token 回发。
 * 与 chat-service 解耦，便于单独测试回发行为（这是最容易被漏掉又最致命的协议点）。
 */
export function createWechatGateway({ cfg, chatService, repo, clock = { now: () => Date.now() }, fetchImpl }) {
  const client = createWechatClient(cfg, { fetchImpl });

  async function replyFor({ userId, text, contextToken }) {
    const { session } = await chatService.resumeOrCreate({ userId, source: 'wechat' });

    let result;
    try {
      result = await chatService.sendMessage({ userId, sessionId: session.sessionId, text });
    } catch (err) {
      // 超时是正常生命周期事件：换一个新会话再答一次，用户无感
      if (err instanceof AppError && err.code === ErrorCodes.SESSION_EXPIRED) {
        const recreated = await chatService.createSession({ userId, source: 'wechat-renew' });
        result = await chatService.sendMessage({ userId, sessionId: recreated.sessionId, text });
        await client.sendText({ toUser: userId, contextToken, text: result.reply });
        return { replied: true, sessionId: recreated.sessionId, renewed: true, result };
      }
      if (err instanceof AppError && err.code === ErrorCodes.SESSION_BUSY) {
        await client.sendText({ toUser: userId, contextToken, text: '上一条还在处理中，请稍等几秒再发。' });
        return { replied: true, sessionId: session.sessionId, busy: true };
      }
      throw err;
    }

    await client.sendText({ toUser: userId, contextToken, text: result.reply });
    return { replied: true, sessionId: session.sessionId, result };
  }

  async function handleWebhook(payload) {
    const inbound = normalizeInbound(payload);
    if (!inbound.userId || !inbound.text) {
      return { replied: false, reason: 'unsupported_message', inbound: { hasUser: Boolean(inbound.userId) } };
    }
    if (!inbound.contextToken) {
      // 不静默丢弃：明确报错，让网关侧告警暴露协议变更
      throw new AppError(ErrorCodes.WECHAT_ERROR, '入站消息缺少 context_token，无法回复', 400, {
        reason: 'missing_context_token',
      });
    }
    return replyFor(inbound);
  }

  async function readCursor() {
    const doc = await repo.getJSON(CURSOR_KEY, { tolerant: true });
    return {
      cursor: typeof doc?.cursor === 'string' ? doc.cursor : '',
      recentIds: Array.isArray(doc?.recentIds) ? doc.recentIds : [],
    };
  }

  async function saveCursor({ cursor, recentIds }) {
    return withLock(repo, CURSOR_LOCK, async () => {
      await repo.setJSON(CURSOR_KEY, {
        cursor,
        recentIds: recentIds.slice(-RECENT_ID_LIMIT),
        updatedAt: clock.now(),
      });
    }, { ttlMs: 5000, waitMs: 5000, pollMs: 30, now: clock.now });
  }

  /**
   * 一次拉取周期。定时任务每 30 秒调一次；单次处理条数与时间都有上限，
   * 保证长轮询 + 逐条推理不会撑爆函数执行时长。
   */
  async function pollOnce({ maxMessages = 10, timeBudgetMs = 20000 } = {}) {
    const startedAt = clock.now();
    const { cursor, recentIds } = await readCursor();
    const batch = await client.getUpdates({ cursor });

    const seen = new Set(recentIds);
    const stats = { fetched: batch.messages.length, replied: 0, skipped: 0, failed: 0, errors: [] };
    let latestCursor = batch.cursor || cursor;

    for (const raw of batch.messages) {
      if (stats.replied + stats.failed >= maxMessages) break;
      if (clock.now() - startedAt > timeBudgetMs) break;

      const inbound = normalizeInbound(raw);
      if (inbound.messageId && seen.has(inbound.messageId)) {
        stats.skipped += 1;
        continue;
      }
      if (inbound.messageId) seen.add(inbound.messageId);

      if (!inbound.userId || !inbound.text || !inbound.contextToken) {
        stats.skipped += 1;
        continue;
      }
      try {
        await replyFor(inbound);
        stats.replied += 1;
      } catch (err) {
        stats.failed += 1;
        stats.errors.push({
          userId: inbound.userId.slice(0, 8),
          code: err?.code ?? 'ERROR',
          message: String(err?.message ?? err).slice(0, 120),
        });
      }
    }

    await saveCursor({ cursor: latestCursor, recentIds: [...seen] });
    return { ...stats, cursor: latestCursor ? `${latestCursor.slice(0, 6)}…` : '', elapsedMs: clock.now() - startedAt };
  }

  return { handleWebhook, pollOnce, client, normalizeInbound };
}
