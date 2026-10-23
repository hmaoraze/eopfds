import test from 'node:test';
import assert from 'node:assert/strict';

import { createRepo } from '../src/blob.js';
import {
  createMemoryService,
  memoryKey,
  similarity,
  computeWeight,
} from '../src/memory.js';
import { sha256Hex } from '../src/crypto-utils.js';
import { createClock, createFakeStore, testConfig } from './helpers.mjs';

function setup(envOverrides = {}) {
  const store = createFakeStore();
  const repo = createRepo(store);
  const clock = createClock();
  const cfg = testConfig(envOverrides);
  const service = createMemoryService({ repo, cfg, clock });
  return { store, repo, clock, cfg, service };
}

test('同一 content 写两次只落一个文件，importance 取大、标签取并集', async () => {
  const { store, service } = setup();
  const content = '用户偏好简洁回答';

  const first = await service.writeBatch('u1', [{ content, importance: 0.8, tags: ['偏好'] }], { source: 'tool_call' });
  assert.equal(first.written.length, 1);

  const second = await service.writeBatch('u1', [{ content, importance: 0.95, tags: ['风格'] }], { source: 'tool_call' });
  assert.equal(second.merged.length, 1);

  const files = store.keys('memories/u1/');
  assert.equal(files.length, 1);

  const doc = store.readJSON(files[0]);
  assert.equal(doc.importance, 0.95);
  assert.equal(doc.mergeCount, 1);
  assert.deepEqual([...doc.tags].sort(), ['偏好', '风格'].sort());
});

test('memoryId 就是 content 的 SHA-256（key 可预测、可幂等）', async () => {
  const { store, service } = setup();
  const content = '用户住在杭州';
  await service.writeBatch('u1', [{ content, importance: 0.6 }], { source: 'tool_call' });
  const expected = memoryKey('u1', await sha256Hex(content));
  assert.deepEqual(store.keys('memories/u1/'), [expected]);
});

test('近似重复（措辞几乎相同）走相似度合并，不新增文件', async () => {
  const { store, service } = setup();
  await service.writeBatch('u1', [{ content: '用户喜欢在早上喝美式咖啡', importance: 0.7 }], { source: 'tool_call' });
  const second = await service.writeBatch('u1', [{ content: '用户喜欢在早上喝美式咖啡。', importance: 0.7 }], { source: 'tool_call' });

  assert.equal(second.merged.length, 1);
  assert.equal(store.keys('memories/u1/').length, 1);
});

test('语义相近但措辞不同不合并（阈值刻意保守，避免误合并不同事实）', async () => {
  const { store, service } = setup();
  await service.writeBatch('u1', [{ content: '用户住在杭州', importance: 0.7 }], { source: 'tool_call' });
  const second = await service.writeBatch('u1', [{ content: '用户居住在杭州市', importance: 0.7 }], { source: 'tool_call' });

  assert.equal(second.written.length, 1);
  assert.equal(store.keys('memories/u1/').length, 2);
  assert.ok(similarity('用户住在杭州', '用户居住在杭州市') < 0.82);
});

test('onlyIfNew 冲突时转入合并，绝不覆盖已有原文', async () => {
  const { store, repo, service, clock } = setup();
  const content = '用户的名字是张三';
  const memoryId = await sha256Hex(content);
  const key = memoryKey('u1', memoryId);

  // 预置一条「已过期但尚未物理清理」的记录：它不会进入活跃集，因此写路径会走到 onlyIfNew
  const seeded = {
    memoryId,
    userId: 'u1',
    content,
    importance: 0.4,
    tags: ['身份'],
    createdAt: clock.now() - 10_000_000,
    updatedAt: clock.now() - 10_000_000,
    lastAccessedAt: clock.now() - 10_000_000,
    isActive: true,
    expiresAt: clock.now() - 1,
    mergeCount: 0,
  };
  await repo.setJSON(key, seeded);

  const result = await service.writeBatch('u1', [{ content, importance: 0.9, tags: ['姓名'] }], { source: 'tool_call' });
  assert.equal(result.written.length, 0);
  assert.equal(result.merged.length, 1);
  assert.equal(store.keys('memories/u1/').length, 1);

  const doc = store.readJSON(key);
  assert.equal(doc.content, content, '原有 content 不得被新内容覆盖');
  assert.equal(doc.importance, 0.9);
  assert.equal(doc.mergeCount, 1);
});

test('weight = importance × exp(-λ × daysSinceLastAccess)', () => {
  const now = 1_700_000_000_000;
  const fresh = { importance: 1, lastAccessedAt: now };
  const week = { importance: 1, lastAccessedAt: now - 7 * 86400000 };
  const lambda = 0.02;

  assert.equal(computeWeight(fresh, now, lambda), 1);
  assert.ok(Math.abs(computeWeight(week, now, lambda) - Math.exp(-0.14)) < 1e-9);
  assert.ok(computeWeight(week, now, lambda) < computeWeight(fresh, now, lambda));
  // importance 参与乘法
  assert.equal(computeWeight({ importance: 0.5, lastAccessedAt: now }, now, lambda), 0.5);
});

test('容量上限：超出部分按 weight 升序逻辑淘汰（isActive=false，文件保留）', async () => {
  const { store, service } = setup({ MEMORY_MAX_ITEMS: '2' });
  const result = await service.writeBatch(
    'u1',
    [
      { content: '事实甲：用户学习日语', importance: 0.9 },
      { content: '事实乙：用户养了一只布偶猫', importance: 0.5 },
      { content: '事实丙：用户周末去爬山', importance: 0.2 },
    ],
    { source: 'tool_call' },
  );

  assert.equal(result.written.length, 3);
  assert.equal(result.capacity.deactivated.length, 1);
  assert.equal(store.keys('memories/u1/').length, 3, '逻辑淘汰不删文件');

  const docs = store.keys('memories/u1/').map((k) => store.readJSON(k));
  const inactive = docs.filter((d) => d.isActive === false);
  assert.equal(inactive.length, 1);
  assert.equal(inactive[0].importance, 0.2);
  assert.equal(inactive[0].deactivateReason, 'capacity');
});

test('TTL 过期后不再召回，并能被逻辑淘汰', async () => {
  const { service, clock } = setup({ MEMORY_TTL_MS: '60000' });
  await service.writeBatch('u1', [{ content: '用户偏好简短回复', importance: 0.8 }], { source: 'tool_call' });

  const before = await service.recall('u1');
  assert.equal(before.items.length, 1);

  clock.advance(120_000);

  const after = await service.recall('u1');
  assert.equal(after.items.length, 0);
  assert.equal(after.summary, '');

  const expired = await service.deactivateExpired('u1');
  assert.equal(expired.deactivated.length, 1);
});

test('召回按 weight 降序，且摘要为纯条目文本（无空行、不夹带指令）', async () => {
  const { service } = setup();
  await service.writeBatch('u1', [{ content: '高权重：用户是后端工程师', importance: 0.95 }], { source: 'tool_call' });
  await service.writeBatch('u1', [{ content: '低权重：用户喜欢喝冰美式', importance: 0.2 }], { source: 'tool_call' });

  const recall = await service.recall('u1', { k: 2 });
  assert.equal(recall.items.length, 2);
  assert.ok(recall.items[0].weight >= recall.items[1].weight);
  assert.match(recall.items[0].content, /后端工程师/);

  for (const line of recall.summary.split('\n')) {
    assert.ok(line.startsWith('- '), `摘要行格式异常: ${line}`);
  }
  assert.ok(!recall.summary.includes('\n\n'));
});

test('摘要长度受 memorySummaryMaxChars 约束并给出截断标注', async () => {
  const { service } = setup({ MEMORY_SUMMARY_MAX_CHARS: '200' });
  const contents = [
    '事实甲：用户是一名后端开发工程师，日常工作主要写 Go 服务和 Node.js 工具链',
    '事实乙：用户家里养了一只三岁的布偶猫，名字叫团子，每天早上会叫醒他',
    '事实丙：用户每年冬天都会去哈尔滨住两周，主要是为了看冰雪大世界的夜景',
    '事实丁：用户每天上午要喝两杯冰美式，不加糖不加奶，下午改喝无糖乌龙茶',
    '事实戊：用户正在自学日语，目标是明年七月的 JLPT N2，每天背三十个单词',
    '事实己：用户非常讨厌没有议程的临时会议，习惯把讨论压到十五分钟以内结束',
    '事实庚：用户写代码只用 Vim 和 tmux，拒绝使用任何需要鼠标操作的编辑器插件',
    '事实辛：用户从二〇一九年起住在杭州余杭区，通勤靠地铁五号线，单程四十分钟',
    '事实壬：用户有一个比他小六岁的妹妹，现在在成都读大学，专业是视觉传达设计',
    '事实癸：用户周末喜欢看悬疑片和犯罪纪录片，最讨厌被剧透结局和关键反转',
  ];
  await service.writeBatch(
    'u1',
    contents.map((content, i) => ({ content, importance: 0.9 - i * 0.01 })),
    { source: 'tool_call' },
  );

  const recall = await service.recall('u1', { k: 10 });
  assert.ok(recall.items.length === 10, `预期 10 条独立记忆，实际 ${recall.items.length}`);
  assert.ok(recall.summary.length <= 260, `摘要超出上限: ${recall.summary.length}`);
  assert.match(recall.summary, /未展开/);
});

test('空白 content 被丢弃并记录原因，不产生文件', async () => {
  const { store, service } = setup();
  const result = await service.writeBatch('u1', [{ content: '   ', importance: 0.9 }], { source: 'tool_call' });
  assert.equal(result.written.length, 0);
  assert.equal(result.invalid.length, 1);
  assert.equal(store.keys('memories/u1/').length, 0);
});

test('通道 B 与通道 A 共用同一去重逻辑（同内容不会产生第二条）', async () => {
  const { store, service } = setup();
  await service.writeBatch('u1', [{ content: '用户是产品经理', importance: 0.8 }], { source: 'tool_call' });
  await service.writeBatch('u1', [{ content: '用户是产品经理', importance: 0.8 }], { source: 'session_summary' });
  assert.equal(store.keys('memories/u1/').length, 1);
});

test('兼容精简版 SDK：没有 getJSON/setJSON、onlyIfNew 被忽略时仍正确去重', async () => {
  // 模拟只实现 get/set/delete/list 的最小 Store：set 忽略 options，绝不抛「已存在」
  const base = createFakeStore();
  const minimalStore = {
    get: (key) => base.get(key),
    set: async (key, value) => {
      base.map.set(key, value);
      return { key };
    },
    delete: (key) => base.delete(key),
    list: (options) => base.list(options),
  };

  const repo = createRepo(minimalStore);
  const clock = createClock();
  const service = createMemoryService({ repo, cfg: testConfig(), clock });

  const first = await service.writeBatch('u1', [{ content: '用户偏好极简回复', importance: 0.4 }], { source: 'tool_call' });
  assert.equal(first.written.length, 1);

  const second = await service.writeBatch('u1', [{ content: '用户偏好极简回复', importance: 0.9 }], { source: 'tool_call' });
  assert.equal(second.merged.length, 1, '去重不能依赖 onlyIfNew 生效');

  const files = base.keys('memories/u1/');
  assert.equal(files.length, 1);
  assert.equal(base.readJSON(files[0]).importance, 0.9);
});
