/**
 * 低频维护任务入口：node-functions/cron/maintenance.js → /cron/maintenance
 *
 * 职责（B4.5 的落地部分）：
 * 1. 把已超时的活跃会话结算为 expired，并补跑通道 B 提炼（否则「超时后没人再访问」的会话永远不提炼）。
 * 2. 把 expiresAt 已过的记忆标记为非活跃（逻辑删除）。
 * 3. 执行容量淘汰。
 * 4. 物理删除「非活跃且超过保留期」的记忆文件（Blob 没有 TTL 自动删除，必须有人干这件事）。
 *
 * 鉴权见 src/auth.js#verifyCronRequest：header → query → payload 三种载体，
 * 因为平台内置 schedules 只能配 path / method / payload，不能自定义请求头。
 *
 * 时长约束：Node Functions 单次运行默认 30 秒（edgeone.json 的 maxDuration 可调到 120）。
 * 因此默认只扫 25 个用户，靠「每小时跑一次 + 每次推进」收敛，而不是一次扫全量。
 */

import { loadConfig, assertChatReady } from '../../src/config.js';
import { createRepo, resolveStore } from '../../src/blob.js';
import { createChatService } from '../../src/chat-service.js';
import { jsonResponse, errorResponse, createBodyReader } from '../../src/http.js';
import { randomToken } from '../../src/crypto-utils.js';
import { verifyCronRequest } from '../../src/auth.js';

export default async function onRequest(context) {
  const request = context?.request ?? context;
  const env = context?.env ?? {};
  const requestId = randomToken(6);

  try {
    const cfg = loadConfig(env);
    const url = new URL(request?.url ?? 'http://localhost/cron/maintenance');
    const body = createBodyReader(request);
    const payload = await body.json().catch(() => ({}));

    const auth = await verifyCronRequest({ request, cfg, url, payload });
    assertChatReady(cfg);

    const repo = createRepo(await resolveStore(cfg, undefined));
    const chat = createChatService({
      cfg,
      repo,
      clock: { now: () => Date.now() },
      waitUntil: context?.waitUntil,
    });

    const maxUsers = Math.min(Math.max(Number(payload.maxUsers ?? 25) || 25, 1), 100);
    const result = await chat.sweepAll({ maxUsers });

    return jsonResponse(
      { ok: true, job: 'maintenance', authVia: auth.via, maxUsers, ...result },
      { headers: { 'x-request-id': requestId } },
    );
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
