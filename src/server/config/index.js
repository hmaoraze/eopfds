/**
 * 运行时配置解析。
 *
 * 取值优先级：管理端写入 KV 的覆盖值  >  平台环境变量（context.env）  >  Schema 默认值。
 * 敏感字段（type=secret）在读取时也参与覆盖逻辑，便于运营期轮换 Key 而无需重新部署。
 */

import { SCHEMA, SCHEMA_BY_KEY } from './schema.js';

function parseScalar(raw, field) {
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  switch (field.type) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return field.default;
      if (typeof field.min === 'number') return Math.min(field.max ?? Infinity, Math.max(field.min, n));
      return n;
    }
    case 'boolean':
      if (value === '') return field.default;
      return /^(1|true|yes|on)$/i.test(value);
    case 'json': {
      if (!value) return field.default;
      try {
        return JSON.parse(value);
      } catch {
        return field.default;
      }
    }
    case 'select':
      return field.options?.includes(value) ? value : field.default;
    default:
      return value === '' ? (field.default ?? '') : value;
  }
}

/**
 * @param {Record<string,string>|undefined} env  Platform env (context.env)
 * @param {Record<string,any>} overrides        KV 中保存的覆盖值
 */
export function buildConfig(env = {}, overrides = {}) {
  const cfg = { _raw: {}, _overrides: new Set() };
  for (const field of SCHEMA) {
    const fromOverride = overrides?.[field.key] !== undefined && overrides?.[field.key] !== null && overrides?.[field.key] !== '';
    const source = fromOverride ? overrides : (field.env ? env : {});
    const raw = source?.[field.key];
    let value = (raw === undefined || raw === null || raw === '') ? field.default : undefined;
    if (value === undefined) {
      if (field.type === 'json' && typeof raw === 'object') value = raw;
      else if (field.type === 'number' && typeof raw === 'number') value = raw;
      else if (field.type === 'boolean' && typeof raw === 'boolean') value = raw;
      else value = parseScalar(raw, field);
    }
    cfg[field.key] = value;
    cfg._raw[field.key] = value;
    if (fromOverride) cfg._overrides.add(field.key);
  }

  // 派生项
  cfg.SESSION_END_COMMAND_LIST = String(cfg.SESSION_END_COMMANDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  cfg.ADMIN_ORIGIN_LIST = String(cfg.ADMIN_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  cfg.MEMORY_TTL_MS = Number(cfg.MEMORY_TTL_DAYS) > 0 ? Number(cfg.MEMORY_TTL_DAYS) * 86400_000 : 0;
  cfg.hasILinkDelivery = Boolean(cfg.ILINK_BOT_TOKEN) && cfg.ILINK_DELIVER;

  const w = cfg.MEMORY_WEIGHTS || {};
  const wsum = (Number(w.importance) || 0) + (Number(w.recency) || 0) + (Number(w.frequency) || 0) + (Number(w.relevance) || 0);
  cfg.MEMORY_WEIGHTS_NORMALIZED = wsum > 0
    ? {
        importance: (Number(w.importance) || 0) / wsum,
        recency: (Number(w.recency) || 0) / wsum,
        frequency: (Number(w.frequency) || 0) / wsum,
        relevance: (Number(w.relevance) || 0) / wsum,
      }
    : { importance: 0.4, recency: 0.3, frequency: 0.15, relevance: 0.15 };

  return cfg;
}

/** 校验必填项，返回缺失列表。 */
export function validateConfig(cfg) {
  const missing = [];
  for (const key of Object.keys(SCHEMA_BY_KEY)) {
    const field = SCHEMA_BY_KEY[key];
    if (!field.required) continue;
    let empty = false;
    const v = cfg[key];
    if (v === undefined || v === null) empty = true;
    else if (typeof v === 'string' && v.trim() === '') empty = true;
    if (empty) missing.push({ key: field.key, label: field.label, group: field.group });
  }
  return { ok: missing.length === 0, missing };
}

/** 把配置序列化成可下发给前端的形态（脱敏 + 标注来源）。 */
export function serializeConfigForAdmin(cfg, { revealSecrets = false } = {}) {
  const values = {};
  const meta = {};
  for (const field of SCHEMA) {
    const overridden = cfg._overrides?.has(field.key);
    meta[field.key] = { source: overridden ? 'store' : 'env', masked: field.type === 'secret' };
    if (field.type === 'secret') {
      const val = cfg[field.key] || '';
      if (revealSecrets) values[field.key] = val;
      else values[field.key] = val ? `${val.slice(0, 3)}***${val.slice(-4)}` : '';
    } else if (field.type === 'json') {
      values[field.key] = cfg[field.key];
    } else if (typeof cfg[field.key] === 'boolean') {
      values[field.key] = cfg[field.key];
    } else {
      values[field.key] = cfg[field.key] ?? '';
    }
  }
  return { values, meta };
}

/** 前端提交的覆盖值 → 合法化（剔除未知键、空 secret 表示不修改）。 */
export function sanitizeOverrides(input, previousOverrides = {}) {
  const out = {};
  for (const field of SCHEMA) {
    if (!(field.key in input)) continue;
    let v = input[field.key];
    if (field.type === 'secret') {
      // 脱敏占位符或未修改 → 保持原有值
      const isMask = typeof v === 'string' && v.includes('***');
      if (v === '' || v === null || v === undefined || isMask) {
        if (previousOverrides[field.key] !== undefined) out[field.key] = previousOverrides[field.key];
        continue;
      }
      out[field.key] = String(v).trim();
      continue;
    }
    out[field.key] = field.type === 'json' && typeof v === 'string' ? safeJson(v, previousOverrides[field.key]) : v;
  }
  return out;
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
