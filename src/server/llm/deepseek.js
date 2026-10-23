/**
 * DeepSeek / OpenAI 兼容 chat completions 客户端。
 * 仅依赖 fetch；支持 function calling（tools）与 json_object 输出模式。
 */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class LLMError extends Error {
  constructor(message, { status, code, retryable, payload } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.payload = payload;
  }
}

function endpoint(cfg) {
  const base = String(cfg.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

export class DeepSeekClient {
  constructor(cfg, { apiKey, model, timeoutMs, fetchImpl = globalThis.fetch } = {}) {
    this.cfg = cfg;
    this.apiKey = apiKey ?? cfg.DEEPSEEK_API_KEY;
    this.model = model ?? (cfg.DEEPSEEK_MODEL || 'deepseek-chat');
    this.timeoutMs = Number(timeoutMs ?? cfg.DEEPSEEK_TIMEOUT_MS) || 60000;
    this.fetchImpl = fetchImpl;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  /**
   * @param {Array<{role:string,content?:string,name?:string,tool_call_id?:string,tool_calls?:any}>} messages
   * @param {object} options { tools, toolChoice, temperature, topP, maxTokens, jsonMode, stop }
   * @returns {Promise<{content:string, toolCalls:Array<object>, raw:object, usage:object, finishReason:string}>}
   */
  async chat(messages, options = {}) {
    if (!this.configured) throw new LLMError('未配置 DEEPSEEK_API_KEY', { code: 'no_api_key' });

    const body = {
      model: options.model || this.model,
      messages,
      temperature: options.temperature ?? this.cfg.DEEPSEEK_TEMPERATURE,
      top_p: options.topP ?? this.cfg.DEEPSEEK_TOP_P,
      max_tokens: options.maxTokens ?? this.cfg.DEEPSEEK_MAX_TOKENS,
      stream: false,
    };
    if (Array.isArray(options.tools) && options.tools.length) {
      body.tools = options.tools;
      if (options.toolChoice) body.tool_choice = options.toolChoice;
    }
    if (options.jsonMode) body.response_format = { type: 'json_object' };
    if (options.stop) body.stop = options.stop;

    const maxAttempts = options.retry === false ? 1 : (options.maxAttempts || 2);
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
      try {
        const res = await this.fetchImpl(endpoint(this.cfg), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await res.text();
        let json;
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          throw new LLMError(`DeepSeek 返回非 JSON：${text.slice(0, 200)}`, { status: res.status });
        }

        if (!res.ok) {
          const code = json?.error?.code || json?.code;
          const msg = json?.error?.message || json?.error?.msg || text.slice(0, 300);
          const err = new LLMError(mapUpstreamError(res.status, msg), {
            status: res.status,
            code,
            retryable: RETRYABLE_STATUS.has(res.status),
            payload: json,
          });
          if (err.retryable && attempt < maxAttempts) {
            await sleep(400 * 2 ** (attempt - 1));
            continue;
          }
          throw err;
        }

        const choice = json?.choices?.[0];
        if (!choice) {
          throw new LLMError('DeepSeek 返回体缺少 choices', { payload: json });
        }
        const message = choice.message || {};
        return {
          content: typeof message.content === 'string' ? message.content : (message.content ? JSON.stringify(message.content) : ''),
          toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
          finishReason: choice.finish_reason || '',
          usage: json.usage || {},
          raw: json,
        };
      } catch (error) {
        lastError = error;
        const abort = error?.name === 'AbortError' || error?.name === 'TimeoutError';
        if (abort) {
          lastError = new LLMError(`DeepSeek 请求超时（${options.timeoutMs || this.timeoutMs}ms）`, { code: 'timeout', retryable: true });
        }
        if (lastError instanceof LLMError && lastError.retryable && attempt < maxAttempts) {
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }
        if (!(lastError instanceof LLMError)) {
          lastError = new LLMError(`DeepSeek 请求失败：${lastError?.message || lastError}`, { code: 'network' });
        }
        if (attempt >= maxAttempts) throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new LLMError('DeepSeek 请求失败');
  }

  /** JSON 模式便捷封装，返回解析后的对象；解析失败返回 fallback。 */
  async chatJson(messages, { fallback = null, ...options } = {}) {
    const res = await this.chat(messages, { jsonMode: true, ...options });
    const text = extractJson(res.content);
    try {
      return text ? JSON.parse(text) : fallback;
    } catch {
      return fallback;
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function extractJson(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : s;
  if (candidate.startsWith('{') || candidate.startsWith('[')) return candidate;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) return candidate.slice(start, end + 1);
  return candidate;
}

function mapUpstreamError(status, msg) {
  const prefix = {
    400: 'DeepSeek 请求参数错误',
    401: 'DeepSeek API Key 无效或缺失',
    402: 'DeepSeek 账户余额不足',
    403: 'DeepSeek 拒绝访问（权限不足）',
    404: 'DeepSeek 接口不存在',
    422: 'DeepSeek 无法处理该请求',
    429: 'DeepSeek 请求过于频繁或额度耗尽',
  };
  return `${prefix[status] || `DeepSeek 错误 ${status}`}：${msg}`;
}
