/**
 * 微信 iLink Bot API 客户端 —— 严格按照 https://www.wechatbot.dev/zh/protocol 实现。
 *
 * 端点（相对 baseUrl）：
 *   POST /ilink/bot/get_bot_qrcode?bot_type=3     获取登录二维码
 *   GET  /ilink/bot/get_qrcode_status?qrcode=...  轮询扫码状态
 *   POST /ilink/bot/getupdates                    长轮询拉消息（服务端挂起约 35s）
 *   POST /ilink/bot/sendmessage                   发送文本/媒体
 *   POST /ilink/bot/getconfig                     获取 typing_ticket
 *   POST /ilink/bot/sendtyping                    输入状态（1=开始 2=停止）
 *   POST /ilink/bot/msg/notifystart | notifystop  生命周期通知
 *   POST /ilink/bot/getuploadurl                  获取 CDN 上传参数
 *
 * 通用头：Content-Type / AuthorizationType: ilink_bot_token / Authorization: Bearer <token>
 *        / X-WECHAT-UIN / iLink-App-Id / iLink-App-ClientVersion
 * 通用体：base_info: { channel_version, bot_agent }
 */

import { uuidV4, randomWechatUin, now, truncate } from './lib/util.js';

export const MessageType = { USER: 1, BOT: 2 };
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };
export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
export const MediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };

export const DEFAULT_MAX_REPLY_CHARS = 1800;

/** 服务端 ret/errcode 语义。 */
export const RET_OK = 0;
export const RET_SESSION_EXPIRED = -14;
export const RET_PARAM_ERROR = -2;

/** "2.0.0" → 0x00020000；参见 SDK headers.ts 的编码规则。 */
export function encodeClientVersion(version) {
  const parts = String(version || '2.0.0').split('.').map((p) => parseInt(p, 10) || 0);
  const [major, minor, patch] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

export function commonHeaders(cfg) {
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(encodeClientVersion(cfg.ILINK_CHANNEL_VERSION)),
  };
}

export function authHeaders(cfg, token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': randomWechatUin(),
    ...commonHeaders(cfg),
  };
}

function isSessionExpired(payload) {
  const code = payload?.ret ?? payload?.errcode;
  return Number(code) === RET_SESSION_EXPIRED;
}

/** 把入站 WireMessage 归一化为内部事件。 */
export function parseIncoming(wire) {
  const items = Array.isArray(wire?.item_list) ? wire.item_list : [];
  const parts = [];
  const media = [];
  let primary = 'text';

  for (const item of items) {
    switch (item?.type) {
      case MessageItemType.TEXT: {
        const t = String(item.text_item?.text ?? '').trim();
        if (t) parts.push(t);
        break;
      }
      case MessageItemType.IMAGE:
        primary = parts.length ? primary : 'image';
        media.push({ kind: 'image', cdn: item.image_item?.media, url: item.image_item?.url });
        parts.push('[图片]');
        break;
      case MessageItemType.VOICE:
        primary = parts.length ? primary : 'voice';
        media.push({ kind: 'voice', cdn: item.voice_item?.media, text: item.voice_item?.text });
        parts.push(item.voice_item?.text ? `[语音] ${item.voice_item.text}` : '[语音]');
        break;
      case MessageItemType.FILE:
        primary = parts.length ? primary : 'file';
        media.push({ kind: 'file', cdn: item.file_item?.media, name: item.file_item?.file_name });
        parts.push(`[文件] ${item.file_item?.file_name || ''}`.trim());
        break;
      case MessageItemType.VIDEO:
        primary = parts.length ? primary : 'video';
        media.push({ kind: 'video', cdn: item.video_item?.media });
        parts.push('[视频]');
        break;
      default:
        if (item?.ref_msg?.message_item) {
          const inner = parseIncoming({ ...wire, item_list: [item.ref_msg.message_item] });
          parts.push(`[引用] ${inner.text}`);
        }
        break;
    }
  }

  const fromUserId = String(wire?.from_user_id || '');
  const toUserId = String(wire?.to_user_id || '');
  const isUser = Number(wire?.message_type ?? MessageType.USER) === MessageType.USER;
  const userId = isUser ? fromUserId : toUserId;

  return {
    userId,
    peerUserId: isUser ? toUserId : fromUserId,
    contextToken: String(wire?.context_token || ''),
    messageId: wire?.message_id ?? wire?.seq ?? wire?.client_id ?? '',
    clientId: String(wire?.client_id || ''),
    text: parts.join('\n').trim(),
    type: parts.length ? primary : 'unsupported',
    isUser,
    timestamp: Number(wire?.create_time_ms || now()),
    sessionRef: String(wire?.session_id || ''),
    raw: wire,
    media,
  };
}

/** 构造 sendmessage 所需的 msg 结构（文本）。 */
export function buildTextMessage(userId, contextToken, text, { clientId } = {}) {
  return {
    from_user_id: '',
    to_user_id: userId,
    client_id: clientId || uuidV4(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

export function buildItemMessage(userId, contextToken, items, { clientId } = {}) {
  return {
    from_user_id: '',
    to_user_id: userId,
    client_id: clientId || uuidV4(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: items,
  };
}

/** 长文本智能分片：优先按段落/句子切分。 */
export function chunkText(text, maxChars = DEFAULT_MAX_REPLY_CHARS) {
  const s = String(text || '');
  if (s.length <= maxChars) return s ? [s] : [];
  const chunks = [];
  let buf = '';
  const push = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = '';
  };
  for (const para of s.split(/\n{2,}/)) {
    if (para.length > maxChars) {
      push();
      for (const sentence of para.split(/(?<=[。！？；.!?;]\s*)/)) {
        if (buf.length + sentence.length > maxChars) push();
        buf += sentence;
      }
      push();
    } else if (buf.length + para.length + 2 > maxChars) {
      push();
      buf = para;
    } else {
      buf += (buf ? '\n\n' : '') + para;
    }
  }
  push();
  return chunks.length ? chunks.map((c) => truncate(c, maxChars, '')) : [truncate(s, maxChars, '')];
}

export class ILinkClient {
  /** @param {object} cfg buildConfig 产物 */
  constructor(cfg, { token, baseUrl, fetchImpl = fetch } = {}) {
    this.cfg = cfg;
    this.token = token ?? cfg.ILINK_BOT_TOKEN;
    this.baseUrl = String(baseUrl ?? (cfg.ILINK_BASE_URL || 'https://ilinkai.weixin.qq.com')).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  get configured() {
    return Boolean(this.token);
  }

  baseInfo() {
    return {
      channel_version: this.cfg.ILINK_CHANNEL_VERSION || '2.0.0',
      bot_agent: this.cfg.ILINK_BOT_AGENT || 'EdgeOne-WeChatBot/1.0',
    };
  }

  async #post(path, body, { token = this.token, timeoutMs = 20000, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: authHeaders(this.cfg, token),
        body: JSON.stringify(body),
        signal: signal || controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`iLink ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (isSessionExpired(payload)) {
        const err = new Error('iLink 会话已过期（ret=-14），需要重新扫码登录');
        err.sessionExpired = true;
        err.payload = payload;
        throw err;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 登录 ──────────────────────────────────────────────────────────────

  /** @returns {{qrcode: string, qrcode_img_content: string}} */
  async requestQrCode(localTokenList = [], botType = 3) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${botType}`, {
        method: 'POST',
        headers: { ...commonHeaders(this.cfg), 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_token_list: localTokenList }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`获取二维码失败 HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 轮询扫码状态。返回 status ∈ wait|scaned|confirmed|expired|...
   * confirmed 时携带 bot_token / ilink_bot_id / ilink_user_id / baseurl
   */
  async pollQrStatus(qrcode, verifyCode) {
    let path = `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) path += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: commonHeaders(this.cfg),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`轮询扫码状态失败 HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 消息 ──────────────────────────────────────────────────────────────

  /** 长轮询，服务端挂起约 35s。首次调用传空串游标。 */
  async getUpdates(cursor = '', timeoutMs = 40000, signal) {
    return this.#post('/ilink/bot/getupdates', { get_updates_buf: cursor, base_info: this.baseInfo() }, { timeoutMs, signal });
  }

  async sendMessage(msg) {
    if (!this.configured) return { skipped: true, reason: 'ILINK_BOT_TOKEN 未配置' };
    return this.#post('/ilink/bot/sendmessage', { msg, base_info: this.baseInfo() });
  }

  async sendText(userId, contextToken, text, opts = {}) {
    const chunks = chunkText(text, opts.maxChars || DEFAULT_MAX_REPLY_CHARS);
    const results = [];
    for (const chunk of chunks) {
      results.push(await this.sendMessage(buildTextMessage(userId, contextToken, chunk, opts)));
    }
    return results;
  }

  async getConfig(userId, contextToken) {
    return this.#post('/ilink/bot/getconfig', {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: this.baseInfo(),
    });
  }

  async sendTyping(userId, ticket, status) {
    return this.#post('/ilink/bot/sendtyping', {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status: status === 2 ? 2 : 1,
      base_info: this.baseInfo(),
    });
  }

  notifyStart() {
    return this.#post('/ilink/bot/msg/notifystart', { base_info: this.baseInfo() });
  }

  notifyStop() {
    return this.#post('/ilink/bot/msg/notifystop', { base_info: this.baseInfo() });
  }

  async getUploadUrl(params) {
    return this.#post('/ilink/bot/getuploadurl', { ...params, base_info: this.baseInfo() });
  }
}
