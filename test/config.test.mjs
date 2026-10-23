import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, buildConfigStatus, assertChatReady } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { testConfig, TEST_ENV } from './helpers.mjs';

test('必填项全缺时 requiredMissing 完整且顺序稳定', () => {
  const cfg = loadConfig({});
  assert.deepEqual(cfg.requiredMissing, [
    'DEEPSEEK_API_KEY',
    'BLOB_STORE_NAME',
    'SYSTEM_PROMPT',
    'SESSION_TIMEOUT_MS',
  ]);
});

test('空白提示词被判定为缺失，而不是「空字符串也算配置了」', () => {
  const cfg = loadConfig({ ...TEST_ENV, SYSTEM_PROMPT: '   \n\t ' });
  assert.deepEqual(cfg.requiredMissing, ['SYSTEM_PROMPT']);
});

test('只配 MAKERS_MODELS_KEY 不构成 DEEPSEEK_API_KEY 已配置（C2 不混淆）', () => {
  const cfg = loadConfig({ MAKERS_MODELS_KEY: 'mk-gateway-key' });
  assert.equal(cfg.modelsGatewayKeyPresent, true);
  assert.equal(cfg.deepseekApiKey, '');
  assert.ok(cfg.requiredMissing.includes('DEEPSEEK_API_KEY'));
});

test('非法的 PROMPT_INJECTION_MODE 进入 invalidEntries，不静默回退', () => {
  const cfg = loadConfig({ ...TEST_ENV, PROMPT_INJECTION_MODE: 'auto' });
  assert.equal(cfg.invalidEntries.length, 1);
  assert.equal(cfg.invalidEntries[0].key, 'PROMPT_INJECTION_MODE');
  assert.throws(() => assertChatReady(cfg), (err) => err instanceof AppError && err.status === 503);
});

test('状态接口脱敏：不含 API Key 明文与提示词正文', async () => {
  const cfg = testConfig();
  const status = await buildConfigStatus(cfg);
  const serialized = JSON.stringify(status);

  assert.equal(status.requiredMissing.length, 0);
  assert.ok(!serialized.includes(cfg.deepseekApiKey), '响应体泄漏了 API Key 明文');
  assert.ok(!serialized.includes('你是测试助手'), '响应体泄漏了提示词正文');
  assert.equal(status.checks.deepseekApiKey.masked, 'sk-****abcd');
  assert.match(status.checks.systemPrompt.display, /^已加载（\d+ 字符）$/);
  // Blob Store 名称非敏感，允许明文
  assert.equal(status.checks.blobStoreName.value, 'test-store');
  assert.equal(status.checks.sessionTimeoutMs.value, 60000);
});

test('必填项缺失时状态接口把 requiredMissing 暴露给前端并标记未配置', async () => {
  const cfg = loadConfig({ SESSION_TIMEOUT_MS: '60000' });
  const status = await buildConfigStatus(cfg);
  assert.equal(status.ok, false);
  assert.ok(status.requiredMissing.includes('SYSTEM_PROMPT'));
  assert.equal(status.checks.systemPrompt.configured, false);
  assert.equal(status.checks.systemPrompt.display, '未配置（必须配置）');
});

test('数值型配置越界时记录非法项，并保留默认值', () => {
  const cfg = loadConfig({ ...TEST_ENV, MEMORY_TOP_K: '999' });
  assert.ok(cfg.invalidEntries.some((e) => e.key === 'MEMORY_TOP_K'));
  assert.equal(cfg.memoryTopK, 8);
});
