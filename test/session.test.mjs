import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHarness,
  chatReply,
  toolCall,
  createFakeLlm,
  createClock,
  createFakeStore,
  testConfig,
  TEST_ENV,
} from './helpers.mjs';
import { sessionKey } from '../src/session-service.js';
import { createRepo } from '../src/blob.js';
import { createMemoryService } from '../src/memory.js';
import { createChatService } from '../src/chat-service.js';

async function createSession(harness, userId = 'u1') {
  const res = await harness.call('/api/session/create', { method: 'POST', body: { userId } });
  assert.equal(res.status, 201, res.text);
  return res.json.sessionId;
}

test('创建会话返回超时信息与提示词注入模式', async () => {
  const harness = createHarness();
  const res = await harness.call('/api/session/create', { method: 'POST', body: { userId: 'u1' } });

  assert.equal(res.status, 201);
  assert.match(res.json.sessionId, /^s_/);
  assert.equal(res.json.sessionTimeoutMs, 60000);
  assert.equal(res.json.promptInjectionMode, 'dual_system');
  assert.equal(res.json.memorySummaryApplied, false);

  const doc = harness.store.readJSON(sessionKey('u1', res.json.sessionId));
  assert.equal(doc.status, 'active');
  assert.equal(doc.turnCount, 0);
  assert.ok(doc.systemSnapshot.promptHash.length > 0, '必须记录提示词指纹供审计');
});

test('每轮都注入完整历史，system 段固定在首位且不重复累积', async () => {
  const llm = createFakeLlm([chatReply('第一次回复'), chatReply('第二次回复')]);
  const harness = createHarness({ llm });
  const sessionId = await createSession(harness);

  const first = await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '你好' },
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.reply, '第一次回复');

  const second = await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '再见' },
  });
  assert.equal(second.status, 200, second.text);

  const [call1, call2] = llm.calls;
  assert.equal(call1.body.messages[0].role, 'system');
  assert.equal(call1.body.messages.at(-1).content, '你好');
  assert.equal(call2.body.messages.length, call1.body.messages.length + 2, '第二轮必须带上上一轮问答');
  assert.equal(call2.body.messages.filter((m) => m.role === 'system').length, 1, 'system 段不得随轮次累积');
  assert.equal(call2.body.messages.at(-1).content, '再见');
});

test('tool_calls 回合：写入记忆 + 追加 tool 消息 + 继续生成', async () => {
  const llm = createFakeLlm([
    chatReply(null, {
      toolCalls: [toolCall('call_1', 'save_memory', { content: '用户养了一只布偶猫', importance: 0.8, tags: ['宠物'] })],
    }),
    chatReply('记住了，你养了一只布偶猫。'),
  ]);
  const harness = createHarness({ llm });
  const sessionId = await createSession(harness);

  const res = await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '我养了一只布偶猫，记住' },
  });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.reply, '记住了，你养了一只布偶猫。');
  assert.equal(res.json.toolRounds, 1);
  assert.equal(res.json.memoryWrites[0].ok, true);

  // 记忆落盘
  const memoryFiles = harness.store.keys('memories/u1/');
  assert.equal(memoryFiles.length, 1);
  assert.equal(harness.store.readJSON(memoryFiles[0]).content, '用户养了一只布偶猫');

  // tool 结果消息进了历史（role: tool + 对应 tool_call_id）
  const doc = harness.store.readJSON(sessionKey('u1', sessionId));
  const toolMessages = doc.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].tool_call_id, 'call_1');

  // 第二轮上游请求里带着 tool 交换，模型能接上
  const secondCall = llm.calls[1].body.messages;
  assert.ok(secondCall.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1'));
  assert.equal(llm.calls[1].body.tools[0].function.name, 'save_memory');
});

test('工具轮次达上限后降级为无 tools 的终结请求，不把 tool_calls 抛给用户', async () => {
  const llm = createFakeLlm([
    chatReply(null, { toolCalls: [toolCall('c1', 'save_memory', { content: '事实一：用户在学习日语', importance: 0.5 })] }),
    chatReply(null, { toolCalls: [toolCall('c2', 'save_memory', { content: '事实二：用户计划明年考 N2', importance: 0.6 })] }),
    chatReply('好的，已经记下了。'),
  ]);
  const harness = createHarness({ llm, env: { ...TEST_ENV, TOOL_MAX_ROUNDS: '2' } });
  const sessionId = await createSession(harness);

  const res = await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '我在学日语，明年考 N2' },
  });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.reply, '好的，已经记下了。');
  assert.equal(res.json.toolsExhausted, true);
  assert.equal(llm.calls.at(-1).body.tools, undefined, '终结请求必须不带 tools');
});

test('上游失败时释放 in-flight 标记，会话可立即重试', async () => {
  // 500 属于可重试错误，客户端会重试一次，所以这里备两次失败响应
  const llm = createFakeLlm([{ __status: 500, body: 'boom-1' }, { __status: 500, body: 'boom-2' }, chatReply('重试成功')]);
  const harness = createHarness({ llm });
  const sessionId = await createSession(harness);

  const failed = await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '第一次' },
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error.code, 'UPSTREAM_ERROR');

  const retried = await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '第二次' },
  });
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.reply, '重试成功');
});

test('超时会话：状态置 expired，后续请求 410，并补跑一次提炼', async () => {
  const llm = createFakeLlm([
    chatReply('第一次回复'),
    chatReply('[{"content":"用户正在验证超时行为","importance":0.6,"tags":["测试"]}]'),
  ]);
  const harness = createHarness({ llm });
  const sessionId = await createSession(harness);

  await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '你好' },
  });

  harness.clock.advance(61_000);

  const expired = await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '还在吗' },
  });
  assert.equal(expired.status, 410);
  assert.equal(expired.json.error.code, 'SESSION_EXPIRED');

  const status = await harness.call(`/api/session/${sessionId}?userId=u1`);
  assert.equal(status.json.status, 'expired');
  assert.equal(status.json.endReason, 'timeout');
  assert.equal(status.json.remainingMs, 0);

  await harness.flush();

  const doc = harness.store.readJSON(sessionKey('u1', sessionId));
  assert.ok(doc.distilledAt, '超时应触发通道 B 提炼');
  assert.equal(harness.store.keys('memories/u1/').length, 1);
});

test('显式结束幂等，且提炼只执行一次', async () => {
  const llm = createFakeLlm([
    chatReply('好的'),
    chatReply('[{"content":"用户偏好中文回答","importance":0.7,"tags":["偏好"]}]'),
  ]);
  const harness = createHarness({ llm });
  const sessionId = await createSession(harness);

  await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '以后都用中文回答' },
  });

  const firstEnd = await harness.call(`/api/session/${sessionId}/end`, { method: 'POST', body: { userId: 'u1' } });
  assert.equal(firstEnd.status, 200);
  assert.equal(firstEnd.json.status, 'ended');
  assert.equal(firstEnd.json.distillationScheduled, true);

  await harness.flush();

  const secondEnd = await harness.call(`/api/session/${sessionId}/end`, { method: 'POST', body: { userId: 'u1' } });
  assert.equal(secondEnd.json.alreadyInactive, true);
  assert.equal(secondEnd.json.distillationScheduled, false);

  await harness.flush();

  const distillCalls = llm.calls.filter((c) => String(c.body.messages?.[0]?.content).includes('会话记忆提炼器'));
  assert.equal(distillCalls.length, 1, '同一会话不得重复提炼');
  assert.equal(harness.store.keys('memories/u1/').length, 1);
});

test('提炼输出非法 JSON 时不写入任何记忆，只记录失败原因', async () => {
  const llm = createFakeLlm([chatReply('好的'), chatReply('抱歉我无法总结')]);
  const harness = createHarness({ llm });
  const sessionId = await createSession(harness);

  await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '随便聊聊' },
  });
  await harness.call(`/api/session/${sessionId}/end`, { method: 'POST', body: { userId: 'u1' } });
  await harness.flush();

  assert.equal(harness.store.keys('memories/u1/').length, 0);
  const doc = harness.store.readJSON(sessionKey('u1', sessionId));
  assert.equal(doc.distillationError, 'json_parse_failed');
});

test('并发保护：上一轮未完成时拒绝第二轮（SESSION_BUSY）', async () => {
  const harness = createHarness();
  const sessionId = await createSession(harness);

  const doc = harness.store.readJSON(sessionKey('u1', sessionId));
  doc.pendingTurn = { token: 'inflight', startedAt: harness.clock.now() };
  harness.store.map.set(sessionKey('u1', sessionId), JSON.stringify(doc));

  const res = await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '插队' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'SESSION_BUSY');
});

test('新会话召回记忆并注入摘要，摘要作为首个 system 消息', async () => {
  const llm = createFakeLlm([chatReply('你好，记得你偏好简洁回答。')]);
  const harness = createHarness({ llm });

  // 先手工写入两条记忆
  const repo = createRepo(harness.store);
  const memories = createMemoryService({ repo, cfg: testConfig(), clock: harness.clock });
  await memories.writeBatch('u2', [
    { content: '用户偏好简洁回答', importance: 0.9, tags: ['偏好'] },
    { content: '用户是后端工程师', importance: 0.8, tags: ['身份'] },
  ], { source: 'tool_call' });

  const created = await harness.call('/api/session/create', { method: 'POST', body: { userId: 'u2' } });
  assert.equal(created.json.memorySummaryApplied, true);
  assert.equal(created.json.memorySummaryItemCount, 2);

  await harness.call(`/api/session/${created.json.sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u2', text: '你好' },
  });

  const messages = llm.calls[0].body.messages;
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /历史记忆摘要/);
  assert.equal(messages[1].role, 'system');
  assert.equal(messages[1].content, TEST_ENV.SYSTEM_PROMPT);
});

test('历史接口过滤 tool 交换，只返回可读对话', async () => {
  const llm = createFakeLlm([
    chatReply(null, { toolCalls: [toolCall('call_x', 'save_memory', { content: '用户在做压测', importance: 0.4 })] }),
    chatReply('收到'),
  ]);
  const harness = createHarness({ llm });
  const sessionId = await createSession(harness);
  await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '我在做压测' },
  });

  const history = await harness.call(`/api/session/${sessionId}/history?userId=u1`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.json.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(history.json.messages[1].content, '收到');
});

test('提炼失败不永久丢弃：巡检可补跑，成功后写入终态不再重试', async () => {
  const llm = createFakeLlm([
    chatReply('好的'),
    chatReply('抱歉我无法总结'),                                                   // 第一次提炼：输出不是 JSON
    chatReply('[{"content":"用户偏好中文回答","importance":0.7,"tags":["偏好"]}]'), // 巡检补跑成功
  ]);
  const harness = createHarness({ llm });
  const sessionId = await createSession(harness);

  await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '以后都用中文回答' },
  });
  await harness.call(`/api/session/${sessionId}/end`, { method: 'POST', body: { userId: 'u1' } });
  await harness.flush();

  let doc = harness.store.readJSON(sessionKey('u1', sessionId));
  assert.equal(doc.distilledAt, null, '失败时不能写终态，否则永远不会重试');
  assert.equal(doc.distillationAttempts, 1);
  assert.equal(doc.distillationError, 'json_parse_failed');

  const chat = createChatService({
    cfg: testConfig(),
    repo: createRepo(harness.store),
    clock: harness.clock,
    waitUntil: () => {},
    fetchImpl: llm.fetchImpl,
  });

  await chat.sweepUser('u1');
  await chat.settleBackground();

  doc = harness.store.readJSON(sessionKey('u1', sessionId));
  assert.equal(doc.distillationAttempts, 2, '失败过的会话应被补跑一次');
  assert.ok(doc.distilledAt, '补跑成功后写终态');
  assert.equal(harness.store.keys('memories/u1/').length, 1);

  // 已有终态：再巡检不应重复调用上游
  await chat.sweepUser('u1');
  await chat.settleBackground();
  assert.equal(harness.store.readJSON(sessionKey('u1', sessionId)).distillationAttempts, 2);
});

test('提炼租约：in-flight 期间的并发巡检不会重复调用上游', async () => {
  const llm = createFakeLlm([chatReply('好的')]);
  const harness = createHarness({ llm });
  const sessionId = await createSession(harness);
  await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '随便聊聊' },
  });

  // 模拟「提炼已经开始但进程被回收」：开始标记存在、终态未写、次数已计 1
  const doc = harness.store.readJSON(sessionKey('u1', sessionId));
  doc.status = 'ended';
  doc.endedAt = harness.clock.now();
  doc.distillationStartedAt = harness.clock.now();
  doc.distillationAttempts = 1;
  doc.distilledAt = null;
  harness.store.map.set(sessionKey('u1', sessionId), JSON.stringify(doc));

  const chat = createChatService({
    cfg: testConfig(),
    repo: createRepo(harness.store),
    clock: harness.clock,
    waitUntil: () => {},
    fetchImpl: llm.fetchImpl,
  });

  await chat.sweepUser('u1');
  await chat.settleBackground();
  assert.equal(harness.store.readJSON(sessionKey('u1', sessionId)).distillationAttempts, 1, '租约内不得重复');

  // 租约（默认 10 分钟）过期后允许接管
  harness.clock.advance(11 * 60 * 1000);
  llm.push(chatReply('[{"content":"用户喜欢闲聊","importance":0.3,"tags":["闲聊"]}]'));
  await chat.sweepUser('u1');
  await chat.settleBackground();

  const after = harness.store.readJSON(sessionKey('u1', sessionId));
  assert.equal(after.distillationAttempts, 2);
  assert.ok(after.distilledAt);
});

test('提炼重试有次数上限，避免坏会话反复消耗预算', async () => {
  const llm = createFakeLlm([chatReply('好的')]);
  const harness = createHarness({ llm });
  const sessionId = await createSession(harness);
  await harness.call(`/api/session/${sessionId}/message`, {
    method: 'POST',
    body: { userId: 'u1', text: '随便聊聊' },
  });
  await harness.call(`/api/session/${sessionId}/end`, { method: 'POST', body: { userId: 'u1' } });
  await harness.flush();

  // 直接把会话改成「已尝试 3 次且未成功」，模拟连续失败
  const doc = harness.store.readJSON(sessionKey('u1', sessionId));
  doc.distillationAttempts = 3;
  doc.distilledAt = null;
  harness.store.map.set(sessionKey('u1', sessionId), JSON.stringify(doc));

  const chat = createChatService({
    cfg: testConfig(),
    repo: createRepo(harness.store),
    clock: harness.clock,
    waitUntil: () => {},
    fetchImpl: llm.fetchImpl,
  });
  const result = await chat.sweepUser('u1');
  await chat.settleBackground();

  assert.deepEqual(result.retriedSessions, []);
  assert.equal(harness.store.readJSON(sessionKey('u1', sessionId)).distillationAttempts, 3);
});

test('不存在的会话返回 404，非法 userId 返回 400', async () => {
  const harness = createHarness();
  const missing = await harness.call('/api/session/s_doesnotexist/message', {
    method: 'POST',
    body: { userId: 'u1', text: 'hi' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'SESSION_NOT_FOUND');

  const badUser = await harness.call('/api/session/create', { method: 'POST', body: { userId: 'a/b' } });
  assert.equal(badUser.status, 400);
});
