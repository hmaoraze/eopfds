/**
 * DeepSeek /chat/completions 客户端。
 *
 * 上游是无状态的（A5）：本客户端不持有任何会话状态，也不接受外部传入的「上一轮 id」，
 * 每次调用都必须由调用方传完整 messages。
 *
 * 错误处理约定：
 * - 网络错误、超时、429、5xx 做一次重试；4xx（除 429）直接失败，不浪费配额。
 * - 抛出的 AppError.details 里只放状态码与截断后的上游报文，绝不放请求头（含 Authorization）。
 */

import { AppError, ErrorCodes } from './errors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function createDeepSeekClient(cfg, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const maxRetries = deps.maxRetries ?? 1;

  async function callOnce({ messages, tools, temperature, maxTokens, timeoutMs }) {
    if (typeof fetchImpl !== 'function') {
      throw new AppError(ErrorCodes.UPSTREAM_ERROR, '运行时缺少 fetch 实现', 500);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? cfg.deepseekTimeoutMs);

    const body = {
      model: cfg.deepseekModel,
      messages,
      stream: false,
      temperature,
      max_tokens: maxTokens,
    };
    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    let response;
    try {
      response = await fetchImpl(`${cfg.deepseekBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.deepseekApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const timedOut = err?.name === 'AbortError';
      const error = new AppError(
        ErrorCodes.UPSTREAM_ERROR,
        timedOut ? 'DeepSeek 请求超时' : 'DeepSeek 网络请求失败',
        502,
        { timedOut, retryable: true },
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AppError(ErrorCodes.UPSTREAM_ERROR, `DeepSeek 返回 ${response.status}`, 502, {
        upstreamStatus: response.status,
        upstreamBody: String(text).slice(0, 300),
        retryable: RETRYABLE_STATUS.has(response.status),
      });
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new AppError(ErrorCodes.UPSTREAM_PARSE_ERROR, 'DeepSeek 响应不是合法 JSON', 502);
    }

    const choice = data?.choices?.[0];
    if (!choice?.message) {
      throw new AppError(ErrorCodes.UPSTREAM_PARSE_ERROR, 'DeepSeek 响应缺少 choices[0].message', 502);
    }

    return {
      message: choice.message,
      finishReason: choice.finish_reason ?? null,
      usage: data.usage ?? null,
    };
  }

  async function chat(options) {
    const params = {
      temperature: 0.3,
      maxTokens: 1024,
      ...options,
    };
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await callOnce(params);
      } catch (err) {
        lastError = err;
        const retryable = err instanceof AppError && err.details?.retryable === true;
        if (!retryable || attempt === maxRetries) break;
        await sleep(300 * (attempt + 1));
      }
    }
    throw lastError;
  }

  return { chat };
}
