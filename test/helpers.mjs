/** 测试脚手架：伪造 env / 时钟 / DeepSeek 上游 / 请求上下文。 */

import { handleRequest } from '../src/router.js';
import { loadConfig } from '../src/config.js';
import { createFakeStore } from './fake-store.mjs';

export const TEST_ENV = Object.freeze({
  DEEPSEEK_API_KEY: 'sk-test-1234567890abcd',
  BLOB_STORE_NAME: 'test-store',
  SYSTEM_PROMPT: '你是测试助手。只回答问题，不要闲聊。',
  SESSION_TIMEOUT_MS: '60000',
  ADMIN_TOKEN: 'admin-token-123456',
  ADMIN_HMAC_SECRET: 'admin-hmac-secret-abcdef',
  CRON_SECRET: 'cron-secret-xyz',
  WECHATBOT_TOKEN: 'wechat-bot-token',
  WECHATBOT_WEBHOOK_SECRET: 'webhook-secret-1',
  WECHATBOT_BASE_URL: 'https://wechat.example.com',
});

export function testConfig(overrides = {}) {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

export function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    set(value) {
      current = value;
    },
  };
}

export function chatReply(content, { toolCalls, usage } = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls ? (content ?? '') : content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: usage ?? { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

export function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

/**
 * 假上游：按队列返回响应，并记录每次请求体（用于断言 system 段与历史拼接）。
 * 队列元素可以是对象，也可以是 (body) => 对象 的函数，便于按调用序号返回不同内容。
 */
export function createFakeLlm(responses = []) {
  const queue = [...responses];
  const calls = [];

  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body ?? '{}');
    calls.push({ url, body, headers: init.headers });
    if (queue.length === 0) {
      throw new Error(`伪造上游响应队列已空（第 ${calls.length} 次调用）`);
    }
    const next = queue.shift();
    const payload = typeof next === 'function' ? next(body) : next;
    if (payload && typeof payload === 'object' && payload.__status) {
      return new Response(String(payload.body ?? 'error'), { status: payload.__status });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return { fetchImpl, calls, queue, push: (r) => queue.push(r) };
}

export function makeRequest(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
  }
  return new Request(`https://demo.example.com${path}`, init);
}

/**
 * 一次完整的 HTTP 级调用，走真实路由与真实响应序列化。
 * 默认注入内存 store 与假上游，因此不触网。
 */
export function createHarness({ env = TEST_ENV, store = createFakeStore(), llm = createFakeLlm([]), clock = createClock() } = {}) {
  const pending = [];
  const deps = {
    store,
    fetchImpl: llm.fetchImpl,
    clock,
    waitUntil: (promise) => pending.push(Promise.resolve(promise)),
  };

  async function call(path, options = {}) {
    const request = makeRequest(path, options);
    const response = await handleRequest({ request, env, waitUntil: deps.waitUntil }, deps);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  }

  /** 等待所有 waitUntil 任务落盘（提炼、touch 等）。 */
  async function flush() {
    while (pending.length > 0) {
      await Promise.allSettled(pending.splice(0));
    }
  }

  return { call, flush, store, llm, clock, env, deps };
}

export { createFakeStore };
