/**
 * 本地预览服务器（仅开发用，不参与部署）。
 *
 * 用途：在没有任何云端凭证的情况下，把整条 HTTP 链路跑起来，方便
 *   1. 联调 public/admin.html 的签名与状态渲染；
 *   2. 用 curl 验证 docs/B-deploy-verify.md 里的命令是否真的可用。
 *
 * 它用内存 store 替换 Blob，用固定回复替换 DeepSeek，所以不能用来验证记忆质量，
 * 只能验证协议、路由、鉴权与响应结构。
 *
 * 启动：node scripts/dev-server.mjs [port]
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { handleRequest } from '../src/router.js';
import { createFakeStore } from '../test/fake-store.mjs';

const port = Number(process.argv[2] ?? 8787);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = {
  DEEPSEEK_API_KEY: 'sk-dev-000000000000abcd',
  BLOB_STORE_NAME: 'local-dev-store',
  SYSTEM_PROMPT: '你是一个用于本地联调的测试助手。回答保持一句话。',
  SESSION_TIMEOUT_MS: '1800000',
  ADMIN_TOKEN: 'dev-admin-token-123456',
  ADMIN_HMAC_SECRET: 'dev-hmac-secret-abcdef',
  CRON_SECRET: 'dev-cron-secret',
  WECHATBOT_TOKEN: 'dev-wechat-token',
  WECHATBOT_WEBHOOK_SECRET: 'dev-webhook-secret',
  ...process.env,
};

const store = createFakeStore();

/** 假上游：回显最后一句话，并声明一次 save_memory 工具调用，便于观察记忆落盘。 */
async function fakeFetch(url, init) {
  const body = JSON.parse(init.body ?? '{}');
  if (!String(url).includes('/chat/completions')) {
    return new Response(JSON.stringify({ ret: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  // 通道 B：会话提炼请求单独给一个结构化 JSON 数组，便于观察记忆是否落盘
  if (String(body.messages?.[0]?.content ?? '').includes('会话记忆提炼器')) {
    return new Response(JSON.stringify({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '[{"content":"用户下周三去上海出差","importance":0.8,"tags":["行程","上海"]}]',
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const hasToolResult = body.messages.some((m) => m.role === 'tool');
  const wantsMemory = /记住|remember/.test(lastUser?.content ?? '') && !hasToolResult && Array.isArray(body.tools);

  const message = wantsMemory
    ? {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_dev_1',
          type: 'function',
          function: {
            name: 'save_memory',
            arguments: JSON.stringify({ content: `用户提到：${String(lastUser.content).slice(0, 40)}`, importance: 0.6, tags: ['联调'] }),
          },
        }],
      }
    : { role: 'assistant', content: `[dev] 收到：${lastUser?.content ?? ''}` };

  return new Response(JSON.stringify({
    choices: [{ index: 0, message, finish_reason: wantsMemory ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname === '/admin.html' || url.pathname === '/') {
    const html = await readFile(path.join(root, 'public', 'admin.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString('utf8');

  const request = new Request(url.toString(), {
    method: req.method,
    headers: req.headers,
    ...(bodyText ? { body: bodyText } : {}),
  });

  const response = await handleRequest(
    { request, env, waitUntil: (p) => Promise.resolve(p).catch(() => {}) },
    { store, fetchImpl: fakeFetch },
  );

  const text = await response.text();
  const headers = {};
  response.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(response.status, headers);
  res.end(text);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${port}/admin.html`);
  console.log(`admin token: ${env.ADMIN_TOKEN}`);
  console.log(`admin secret: ${env.ADMIN_HMAC_SECRET}`);
});
