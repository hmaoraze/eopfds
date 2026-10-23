import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, chatReply, createFakeLlm, TEST_ENV } from './helpers.mjs';
import { signAdminRequest } from '../src/auth.js';

const ADMIN_PATH = '/api/admin/config/status';

async function adminHeaders({ timestamp = Date.now(), token = TEST_ENV.ADMIN_TOKEN, secret = TEST_ENV.ADMIN_HMAC_SECRET, rawBody = '' } = {}) {
  const signed = await signAdminRequest({
    method: 'GET',
    path: ADMIN_PATH,
    timestamp,
    rawBody,
    token,
    secret,
  });
  return signed.headers;
}

test('health 无需配置即可访问，并如实报告缺失项', async () => {
  const harness = createHarness({ env: {} });
  const res = await harness.call('/api/health');

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.configured, false);
  assert.deepEqual(res.json.requiredMissing, [
    'DEEPSEEK_API_KEY',
    'BLOB_STORE_NAME',
    'SYSTEM_PROMPT',
    'SESSION_TIMEOUT_MS',
  ]);
});

test('必填配置缺失时业务接口 503，并把 requiredMissing 交给前端', async () => {
  const harness = createHarness({ env: { DEEPSEEK_API_KEY: 'sk-x', BLOB_STORE_NAME: 's' } });
  const res = await harness.call('/api/session/create', { method: 'POST', body: { userId: 'u1' } });

  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'CONFIG_MISSING');
  assert.deepEqual(res.json.error.details.requiredMissing, ['SYSTEM_PROMPT', 'SESSION_TIMEOUT_MS']);
});

test('提示词为空时返回 PROMPT_EMPTY，不带着空 system 段去调上游', async () => {
  const llm = createFakeLlm([chatReply('不应该被调用')]);
  const harness = createHarness({ env: { ...TEST_ENV, SYSTEM_PROMPT: '' }, llm });
  const res = await harness.call('/api/session/create', { method: 'POST', body: { userId: 'u1' } });

  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, 'CONFIG_MISSING');
  assert.equal(llm.calls.length, 0);
});

test('管理面未带签名 → 401', async () => {
  const harness = createHarness();
  const res = await harness.call(ADMIN_PATH);
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHORIZED');
});

test('管理面签名正确 → 200，且响应体不含任何明文凭据', async () => {
  const harness = createHarness();
  const res = await harness.call(ADMIN_PATH, { headers: await adminHeaders({ timestamp: Date.now() }) });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.requiredMissing, []);
  assert.equal(res.json.checks.deepseekApiKey.masked, 'sk-****abcd');
  assert.equal(res.json.checks.blobStoreName.value, 'test-store');

  assert.ok(!res.text.includes(TEST_ENV.DEEPSEEK_API_KEY), '响应体泄漏 API Key');
  assert.ok(!res.text.includes(TEST_ENV.SYSTEM_PROMPT), '响应体泄漏提示词全文');
  assert.ok(!res.text.includes(TEST_ENV.ADMIN_TOKEN), '响应体泄漏管理员 token');
  assert.ok(!res.text.includes(TEST_ENV.ADMIN_HMAC_SECRET), '响应体泄漏 HMAC 密钥');
});

test('时间戳超出窗口 → 401（防重放）', async () => {
  const harness = createHarness();
  const res = await harness.call(ADMIN_PATH, {
    headers: await adminHeaders({ timestamp: Date.now() - 10 * 60 * 1000 }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.details.reason, 'timestamp_out_of_window');
});

test('签名与 token 不匹配 → 401', async () => {
  const harness = createHarness();
  const res = await harness.call(ADMIN_PATH, {
    headers: await adminHeaders({ token: 'wrong-token', secret: 'wrong-secret' }),
  });
  assert.equal(res.status, 401);
});

test('管理面凭据未配置时返回 503 + requiredMissing，而不是放行', async () => {
  const env = { ...TEST_ENV };
  delete env.ADMIN_TOKEN;
  delete env.ADMIN_HMAC_SECRET;
  const harness = createHarness({ env });
  const res = await harness.call(ADMIN_PATH);

  assert.equal(res.status, 503);
  assert.deepEqual(res.json.error.details.requiredMissing, ['ADMIN_TOKEN', 'ADMIN_HMAC_SECRET']);
});

test('未知路由 404、方法不匹配 405', async () => {
  const harness = createHarness();
  const notFound = await harness.call('/api/nope');
  assert.equal(notFound.status, 404);

  const wrongMethod = await harness.call('/api/admin/config/status', { method: 'POST', body: {} });
  assert.equal(wrongMethod.status, 405);
});

test('微信回调：回复 payload 必须原样携带入站 context_token', async () => {
  const llm = createFakeLlm([chatReply('你好，我在。')]);
  const harness = createHarness({ llm });
  const sends = [];

  harness.deps.fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/chat/completions')) return llm.fetchImpl(url, init);
    sends.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ret: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const res = await harness.call('/api/wechat/webhook', {
    method: 'POST',
    headers: { 'x-wechatbot-secret': TEST_ENV.WECHATBOT_WEBHOOK_SECRET },
    body: {
      msg: {
        from_user_name: 'oUser-001',
        context_token: 'ct-abc',
        msg_id: 'm-1',
        item_list: [{ type: 1, text_item: { text: '在吗' } }],
      },
    },
  });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.replied, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].msg.context_token, 'ct-abc');
  assert.equal(sends[0].msg.to_user_name, 'oUser-001');
  assert.equal(sends[0].msg.item_list[0].text_item.text, '你好，我在。');
});

test('微信回调缺少 context_token → 拒绝回复（不发到错误窗口）', async () => {
  const llm = createFakeLlm([chatReply('不该发出')]);
  const harness = createHarness({ llm });
  const sends = [];
  harness.deps.fetchImpl = async (url, init) => {
    sends.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
  };

  const res = await harness.call('/api/wechat/webhook', {
    method: 'POST',
    headers: { 'x-wechatbot-secret': TEST_ENV.WECHATBOT_WEBHOOK_SECRET },
    body: { msg: { from_user_name: 'oUser-001', item_list: [{ type: 1, text_item: { text: '在吗' } }] } },
  });

  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'WECHAT_ERROR');
  assert.equal(sends.length, 0);
});

test('微信回调密钥错误 → 401', async () => {
  const harness = createHarness();
  const res = await harness.call('/api/wechat/webhook', {
    method: 'POST',
    headers: { 'x-wechatbot-secret': 'wrong' },
    body: { msg: { from_user_name: 'o1', context_token: 'ct', text: 'hi' } },
  });
  assert.equal(res.status, 401);
});

test('长轮询：拉取 → 逐条回复 → 落游标，且同一 msg_id 不重复处理', async () => {
  const llm = createFakeLlm([chatReply('第一轮回复'), chatReply('第二轮回复')]);
  const harness = createHarness({ llm });
  const batches = [
    { ret: 0, get_updates_buf: 'buf-1', msgs: [{ from_user_name: 'oPoll1', context_token: 'ct-poll', msg_id: 'pm-1', text: '你好' }] },
    { ret: 0, get_updates_buf: 'buf-2', msgs: [] },
  ];
  const sends = [];
  harness.deps.fetchImpl = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/chat/completions')) return llm.fetchImpl(url, init);
    if (target.endsWith('/getupdates')) {
      const payload = batches.shift() ?? { ret: 0, get_updates_buf: 'buf-end', msgs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    sends.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ret: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const first = await harness.call('/api/wechat/poll', {
    method: 'POST',
    headers: { 'x-cron-secret': TEST_ENV.CRON_SECRET },
    body: {},
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.replied, 1);
  assert.equal(sends[0].msg.context_token, 'ct-poll');

  const cursor = harness.store.readJSON('cursors/wechat/cursor.json');
  assert.equal(cursor.cursor, 'buf-1');
  assert.deepEqual(cursor.recentIds, ['pm-1']);

  const second = await harness.call('/api/wechat/poll', {
    method: 'POST',
    headers: { 'x-cron-secret': TEST_ENV.CRON_SECRET },
    body: {},
  });
  assert.equal(second.json.fetched, 0);
});

test('定时任务接口缺少 CRON_SECRET 配置时 503', async () => {
  const env = { ...TEST_ENV };
  delete env.CRON_SECRET;
  const harness = createHarness({ env });
  const res = await harness.call('/api/wechat/poll', { method: 'POST', body: {} });
  assert.equal(res.status, 503);
  assert.deepEqual(res.json.error.details.requiredMissing, ['CRON_SECRET']);
});

test('定时任务凭据支持 query 与 payload 载体（平台 schedules 不能设请求头）', async () => {
  const emptyUpdates = () => new Response(
    JSON.stringify({ ret: 0, get_updates_buf: 'buf-x', msgs: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  // query 载体
  const viaQuery = createHarness();
  viaQuery.deps.fetchImpl = async () => emptyUpdates();
  const q = await viaQuery.call(`/api/wechat/poll?token=${TEST_ENV.CRON_SECRET}`, { method: 'POST', body: {} });
  assert.equal(q.status, 200, q.text);
  assert.equal(q.json.fetched, 0);

  // payload 载体
  const viaPayload = createHarness();
  viaPayload.deps.fetchImpl = async () => emptyUpdates();
  const p = await viaPayload.call('/api/wechat/poll', {
    method: 'POST',
    body: { token: TEST_ENV.CRON_SECRET, maxMessages: 1 },
  });
  assert.equal(p.status, 200, p.text);

  // 错误凭据仍然拒绝
  const wrong = createHarness();
  wrong.deps.fetchImpl = async () => emptyUpdates();
  const w = await wrong.call(`/api/wechat/poll?token=nope`, { method: 'POST', body: {} });
  assert.equal(w.status, 401);
  assert.equal(w.json.error.details.reason, 'bad_cron_secret');
});
