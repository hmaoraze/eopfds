/**
 * 运行时装配：环境变量 → KV 配置覆盖值 → 存储 → 各领域服务。
 */

import { buildConfig, validateConfig } from './config/index.js';
import { createStore } from './storage/index.js';
import { ConfigRepo } from './repository.js';
import { DeepSeekClient } from './llm/deepseek.js';
import { ILinkClient } from './ilink.js';
import { MemoryEngine } from './memory.js';
import { Summarizer } from './summarizer.js';
import { SessionService } from './session.js';
import { ConversationService } from './conversation.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(cfg, sink = console) {
  const threshold = LEVELS[cfg?.LOG_LEVEL] ?? LEVELS.info;
  return (level, event, data) => {
    const lv = LEVELS[level] ?? LEVELS.info;
    if (lv < threshold) return;
    try {
      sink[level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'log'](
        JSON.stringify({ t: Date.now(), level, event, ...(data || {}) }),
      );
    } catch { /* 日志失败不影响主流程 */ }
  };
}

/**
 * @param {object} context EdgeOne EventContext（提供 env / waitUntil / request）
 * @param {object} [options] { allowMemoryFallback, seed }
 */
export async function createRuntime(context, options = {}) {
  const env = context?.env || {};

  // 第一次构建：只需要知道用哪个存储驱动，以便读取配置覆盖值
  const bootstrap = buildConfig(env, {});
  const bootStore = createStore(bootstrap, env, { allowMemoryFallback: true, seed: options.seed });
  const overrides = await ConfigRepo.getOverrides(bootStore).catch(() => ({}));

  const cfg = buildConfig(env, overrides);
  const sameDriver = String(cfg.STORE_DRIVER) === String(bootstrap.STORE_DRIVER)
    && String(cfg.KV_BINDING_NAME) === String(bootstrap.KV_BINDING_NAME)
    && String(cfg.REDIS_REST_URL) === String(bootstrap.REDIS_REST_URL)
    && String(cfg.HTTP_STORE_URL) === String(bootstrap.HTTP_STORE_URL);
  const store = sameDriver ? bootStore : createStore(cfg, env, { allowMemoryFallback: options.allowMemoryFallback, seed: options.seed });

  const log = createLogger(cfg);
  const llm = new DeepSeekClient(cfg, { fetchImpl: globalThis.fetch });
  const ilink = new ILinkClient(cfg, { fetchImpl: globalThis.fetch });
  const memoryEngine = new MemoryEngine(store, cfg, { log });
  const summarizer = new Summarizer({ llm, cfg, memoryEngine, log });
  const sessions = new SessionService({ store, cfg, memoryEngine, summarizer, ilink, log });
  const conversation = new ConversationService({ cfg, llm, ilink, memoryEngine, sessionService: sessions, summarizer, log });

  return {
    env,
    cfg,
    store,
    log,
    overrides,
    validate: () => validateConfig(cfg),
    services: { llm, ilink, memoryEngine, summarizer, sessions, conversation },
    llm,
    ilink,
    memoryEngine,
    summarizer,
    sessions,
    conversation,
  };
}
