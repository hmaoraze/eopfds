/**
 * 配置装载与校验。
 *
 * 设计约束（对应阶段 A 的 A1 / C1 / C2 / C5）：
 * 1. 所有配置只从 context.env 读取，没有第二来源，也没有默认密钥。
 * 2. 必填项缺失时不是「降级运行」，而是业务接口 503 + requiredMissing。
 * 3. MAKERS_MODELS_KEY 与 DEEPSEEK_API_KEY 严格隔离：前者存在也不代表后者可用，
 *    绝不做隐式回退，否则会拿网关凭据去打 DeepSeek 直连地址。
 */

import { AppError, ErrorCodes } from './errors.js';
import { maskSecret, sha256Hex } from './crypto-utils.js';

export const PROMPT_INJECTION_MODES = Object.freeze(['dual_system', 'merged_single_system']);

export const REQUIRED_FIELDS = Object.freeze([
  'DEEPSEEK_API_KEY',
  'BLOB_STORE_NAME',
  'SYSTEM_PROMPT',
  'SESSION_TIMEOUT_MS',
]);

const DEFAULTS = Object.freeze({
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-chat',
  DEEPSEEK_TIMEOUT_MS: 45000,
  DISTILL_TIMEOUT_MS: 15000,
  DISTILL_LOCK_TTL_MS: 600000,
  HISTORY_MAX_MESSAGES: 60,
  TOOL_MAX_ROUNDS: 3,
  PROMPT_INJECTION_MODE: 'dual_system',
  MEMORY_TOOL_ENABLED: 'true',
  MEMORY_MAX_ITEMS: 500,
  MEMORY_TTL_MS: 7776000000, // 90 天
  MEMORY_TOP_K: 8,
  MEMORY_DECAY_LAMBDA: 0.02,
  MEMORY_DEDUP_THRESHOLD: 0.82,
  MEMORY_DEDUP_SCAN_LIMIT: 300,
  MEMORY_HARD_DELETE_AFTER_MS: 604800000, // 7 天
  MEMORY_SUMMARY_MAX_CHARS: 1200,
  SESSION_BUSY_TTL_MS: 120000,
  ADMIN_AUTH_MAX_SKEW_MS: 300000,
  WECHATBOT_BASE_URL: 'https://ilinkai.weixin.qq.com',
  WECHATBOT_GETUPDATES_PATH: '/ilink/bot/getupdates',
  WECHATBOT_SEND_PATH: '/ilink/bot/sendmessage',
  WECHATBOT_POLL_TIMEOUT_MS: 10000,
  WECHATBOT_WEBHOOK_TOLERANCE_MS: 300000,
});

const NUMERIC_RANGES = Object.freeze({
  DEEPSEEK_TIMEOUT_MS: [1000, 120000],
  DISTILL_TIMEOUT_MS: [3000, 60000],
  DISTILL_LOCK_TTL_MS: [60000, 3600000],
  SESSION_TIMEOUT_MS: [1000, 2592000000], // 1 秒 ~ 30 天
  HISTORY_MAX_MESSAGES: [4, 400],
  TOOL_MAX_ROUNDS: [1, 6],
  MEMORY_MAX_ITEMS: [1, 20000],
  MEMORY_TTL_MS: [60000, 315360000000],
  MEMORY_TOP_K: [1, 50],
  MEMORY_DECAY_LAMBDA: [0, 1],
  MEMORY_DEDUP_THRESHOLD: [0.5, 1],
  MEMORY_DEDUP_SCAN_LIMIT: [10, 5000],
  MEMORY_HARD_DELETE_AFTER_MS: [0, 315360000000],
  MEMORY_SUMMARY_MAX_CHARS: [200, 8000],
  SESSION_BUSY_TTL_MS: [5000, 900000],
  ADMIN_AUTH_MAX_SKEW_MS: [30000, 3600000],
  WECHATBOT_POLL_TIMEOUT_MS: [1000, 60000],
});

function readRaw(env, key) {
  const v = env?.[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s.trim() === '' ? undefined : s;
}

/**
 * @param {Record<string, unknown>} env context.env
 * @returns {Readonly<object>} 冻结的配置对象，附带 __meta 记录缺失与非法项
 */
export function loadConfig(env = {}) {
  const invalid = [];
  const numeric = {};

  for (const key of Object.keys(NUMERIC_RANGES)) {
    const raw = readRaw(env, key);
    const fallback = DEFAULTS[key];
    if (raw === undefined) {
      numeric[key] = fallback;
      continue;
    }
    const parsed = Number(raw);
    const [min, max] = NUMERIC_RANGES[key];
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      invalid.push({ key, reason: `必须是 ${min} ~ ${max} 之间的数字`, received: raw });
      numeric[key] = fallback;
      continue;
    }
    numeric[key] = parsed;
  }

  const modeRaw = readRaw(env, 'PROMPT_INJECTION_MODE') ?? DEFAULTS.PROMPT_INJECTION_MODE;
  const promptInjectionMode = modeRaw;
  if (!PROMPT_INJECTION_MODES.includes(modeRaw)) {
    // 不静默回退：枚举外的值意味着部署者意图不明，必须暴露而不是猜
    invalid.push({
      key: 'PROMPT_INJECTION_MODE',
      reason: `只接受 ${PROMPT_INJECTION_MODES.join(' | ')}`,
      received: modeRaw,
    });
  }

  const systemPrompt = readRaw(env, 'SYSTEM_PROMPT') ?? '';
  const sessionTimeoutRaw = readRaw(env, 'SESSION_TIMEOUT_MS');

  const cfg = {
    deepseekApiKey: readRaw(env, 'DEEPSEEK_API_KEY') ?? '',
    deepseekBaseUrl: (readRaw(env, 'DEEPSEEK_BASE_URL') ?? DEFAULTS.DEEPSEEK_BASE_URL).replace(/\/+$/, ''),
    deepseekModel: readRaw(env, 'DEEPSEEK_MODEL') ?? DEFAULTS.DEEPSEEK_MODEL,
    blobStoreName: readRaw(env, 'BLOB_STORE_NAME') ?? '',
    systemPrompt,
    sessionTimeoutMs: numeric.SESSION_TIMEOUT_MS,
    sessionTimeoutMsProvided: sessionTimeoutRaw !== undefined,
    promptInjectionMode,
    historyMaxMessages: numeric.HISTORY_MAX_MESSAGES,
    toolMaxRounds: numeric.TOOL_MAX_ROUNDS,
    memoryToolEnabled: (readRaw(env, 'MEMORY_TOOL_ENABLED') ?? DEFAULTS.MEMORY_TOOL_ENABLED) !== 'false',
    memoryMaxItems: numeric.MEMORY_MAX_ITEMS,
    memoryTtlMs: numeric.MEMORY_TTL_MS,
    memoryTopK: numeric.MEMORY_TOP_K,
    memoryDecayLambda: numeric.MEMORY_DECAY_LAMBDA,
    memoryDedupThreshold: numeric.MEMORY_DEDUP_THRESHOLD,
    memoryDedupScanLimit: numeric.MEMORY_DEDUP_SCAN_LIMIT,
    memoryHardDeleteAfterMs: numeric.MEMORY_HARD_DELETE_AFTER_MS,
    memorySummaryMaxChars: numeric.MEMORY_SUMMARY_MAX_CHARS,
    sessionBusyTtlMs: numeric.SESSION_BUSY_TTL_MS,
    deepseekTimeoutMs: numeric.DEEPSEEK_TIMEOUT_MS,
    distillTimeoutMs: numeric.DISTILL_TIMEOUT_MS,
    distillLockTtlMs: numeric.DISTILL_LOCK_TTL_MS,

    adminToken: readRaw(env, 'ADMIN_TOKEN') ?? '',
    adminHmacSecret: readRaw(env, 'ADMIN_HMAC_SECRET') ?? '',
    adminAuthMaxSkewMs: numeric.ADMIN_AUTH_MAX_SKEW_MS,
    adminOpenidAllowlist: (readRaw(env, 'ADMIN_OPENID_ALLOWLIST') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminOpenidGatewaySecret: readRaw(env, 'ADMIN_OPENID_GATEWAY_SECRET') ?? '',

    wechatbotBaseUrl: (readRaw(env, 'WECHATBOT_BASE_URL') ?? DEFAULTS.WECHATBOT_BASE_URL).replace(/\/+$/, ''),
    wechatbotToken: readRaw(env, 'WECHATBOT_TOKEN') ?? '',
    wechatbotWebhookSecret: readRaw(env, 'WECHATBOT_WEBHOOK_SECRET') ?? '',
    wechatbotGetUpdatesPath: readRaw(env, 'WECHATBOT_GETUPDATES_PATH') ?? DEFAULTS.WECHATBOT_GETUPDATES_PATH,
    wechatbotSendPath: readRaw(env, 'WECHATBOT_SEND_PATH') ?? DEFAULTS.WECHATBOT_SEND_PATH,
    wechatbotPollTimeoutMs: numeric.WECHATBOT_POLL_TIMEOUT_MS,
    wechatbotWebhookToleranceMs: numeric.WECHATBOT_WEBHOOK_TOLERANCE_MS,

    cronSecret: readRaw(env, 'CRON_SECRET') ?? '',

    // 仅用于状态展示时提示「你可能配错了凭据」，绝不参与任何请求
    modelsGatewayKeyPresent: Boolean(readRaw(env, 'MAKERS_MODELS_KEY')),

    invalidEntries: invalid,
  };

  cfg.requiredMissing = REQUIRED_FIELDS.filter((field) => {
    if (field === 'DEEPSEEK_API_KEY') return cfg.deepseekApiKey === '';
    if (field === 'BLOB_STORE_NAME') return cfg.blobStoreName === '';
    if (field === 'SYSTEM_PROMPT') return cfg.systemPrompt.trim() === '';
    if (field === 'SESSION_TIMEOUT_MS') return !cfg.sessionTimeoutMsProvided;
    return false;
  });

  return Object.freeze(cfg);
}

/** 管理面必填项，与业务必填项分开：管理面不可用不应阻断对话。 */
export function adminRequiredMissing(cfg) {
  const missing = [];
  if (!cfg.adminToken) missing.push('ADMIN_TOKEN');
  if (!cfg.adminHmacSecret) missing.push('ADMIN_HMAC_SECRET');
  return missing;
}

export function assertChatReady(cfg) {
  if (cfg.invalidEntries.length > 0) {
    throw new AppError(ErrorCodes.CONFIG_MISSING, '配置项非法，服务拒绝启动', 503, {
      invalid: cfg.invalidEntries.map((e) => e.key),
      requiredMissing: cfg.requiredMissing,
    });
  }
  if (cfg.requiredMissing.length > 0) {
    throw new AppError(ErrorCodes.CONFIG_MISSING, '必填配置缺失，服务拒绝启动', 503, {
      requiredMissing: cfg.requiredMissing,
    });
  }
  if (cfg.systemPrompt.trim() === '') {
    // 双保险：即使 requiredMissing 计算有误，也不允许空提示词进入上游
    throw new AppError(ErrorCodes.PROMPT_EMPTY, '前置提示词为空', 503, {
      requiredMissing: ['SYSTEM_PROMPT'],
    });
  }
  return cfg;
}

export function assertBlobReady(cfg) {
  if (!cfg.blobStoreName) {
    throw new AppError(ErrorCodes.CONFIG_MISSING, 'Blob Store 名称未配置', 503, {
      requiredMissing: ['BLOB_STORE_NAME'],
    });
  }
  return cfg;
}

export function assertAdminReady(cfg) {
  const missing = adminRequiredMissing(cfg);
  if (missing.length > 0) {
    throw new AppError(ErrorCodes.CONFIG_MISSING, '管理面凭据未配置', 503, { requiredMissing: missing });
  }
  return cfg;
}

/**
 * 脱敏状态。硬性要求：本函数返回值经 JSON.stringify 后，不得包含
 * API Key 明文、提示词正文、管理员凭据、微信 token。
 */
export async function buildConfigStatus(cfg) {
  const prompt = cfg.systemPrompt.trim();
  const promptHash = prompt ? (await sha256Hex(prompt)).slice(0, 12) : '';

  return {
    ok: cfg.requiredMissing.length === 0 && cfg.invalidEntries.length === 0,
    requiredMissing: [...cfg.requiredMissing],
    invalidEntries: cfg.invalidEntries.map((e) => ({ key: e.key, reason: e.reason })),
    checks: {
      deepseekApiKey: {
        label: 'DeepSeek API Key',
        required: true,
        configured: cfg.deepseekApiKey !== '',
        masked: cfg.deepseekApiKey ? maskSecret(cfg.deepseekApiKey) : '',
      },
      blobStoreName: {
        label: 'Blob Store 名称',
        required: true,
        configured: cfg.blobStoreName !== '',
        // 非敏感，可明文展示
        value: cfg.blobStoreName,
        consistency: 'strong',
        sdk: '@edgeone/pages-blob >= 0.0.14',
      },
      systemPrompt: {
        label: '前置提示词',
        required: true,
        configured: prompt !== '',
        // 只给长度与短哈希，不给正文
        display: prompt ? `已加载（${prompt.length} 字符）` : '未配置（必须配置）',
        length: prompt.length,
        hash: promptHash,
      },
      sessionTimeoutMs: {
        label: '会话超时时间',
        required: true,
        configured: cfg.sessionTimeoutMsProvided,
        value: cfg.sessionTimeoutMs,
        humanReadable: `${Math.round(cfg.sessionTimeoutMs / 60000)} 分钟`,
      },
    },
    runtime: {
      deepseekBaseUrl: cfg.deepseekBaseUrl,
      deepseekModel: cfg.deepseekModel,
      promptInjectionMode: cfg.promptInjectionMode,
      historyMaxMessages: cfg.historyMaxMessages,
      toolMaxRounds: cfg.toolMaxRounds,
      memory: {
        enabled: cfg.memoryToolEnabled,
        topK: cfg.memoryTopK,
        maxItems: cfg.memoryMaxItems,
        ttlDays: Number((cfg.memoryTtlMs / 86400000).toFixed(1)),
        decayLambda: cfg.memoryDecayLambda,
        dedupThreshold: cfg.memoryDedupThreshold,
      },
    },
    adminAuth: {
      mode: cfg.adminOpenidAllowlist.length > 0 ? 'bearer_hmac + openid_allowlist' : 'bearer_hmac',
      configured: adminRequiredMissing(cfg).length === 0,
      openidAllowlistSize: cfg.adminOpenidAllowlist.length,
    },
    wechat: {
      configured: Boolean(cfg.wechatbotToken),
      baseUrlConfigured: Boolean(cfg.wechatbotBaseUrl),
    },
    warnings: [
      ...(cfg.modelsGatewayKeyPresent && !cfg.deepseekApiKey
        ? ['MAKERS_MODELS_KEY 已设置但 DEEPSEEK_API_KEY 为空：网关凭据不能替代 DeepSeek 直连凭据，本服务不会回退使用。']
        : []),
      ...(cfg.modelsGatewayKeyPresent && cfg.deepseekApiKey
        ? ['同时设置了 MAKERS_MODELS_KEY 与 DEEPSEEK_API_KEY，本服务只使用后者直连 DeepSeek。']
        : []),
      ...(cfg.adminOpenidAllowlist.length > 0 && !cfg.adminOpenidGatewaySecret
        ? ['ADMIN_OPENID_ALLOWLIST 已配置但缺少 ADMIN_OPENID_GATEWAY_SECRET：openid 通道不会启用，仅 Bearer+HMAC 生效。']
        : []),
    ],
  };
}
