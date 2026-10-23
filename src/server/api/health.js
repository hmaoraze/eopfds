/**
 * 健康检查与自检。
 * GET /api/health?deep=1 → 检查配置完整性、存储连通性、DeepSeek 连通性（deep=1 时才探针 LLM）。
 */

import { createRuntime } from '../index.js';
import { fail, corsHeaders, RET } from '../lib/http.js';
import { randomToken, now } from '../lib/util.js';

export async function handleHealthRequest(context) {
  const t0 = now();
  const url = new URL(context.request.url);
  const deep = url.searchParams.get('deep') === '1';
  let rt;
  try {
    rt = await createRuntime(context);
  } catch (e) {
    return json({ ret: RET.UPSTREAM, ok: false, error: `初始化失败：${e.message}` }, 500);
  }

  const validity = rt.validate();
  const report = {
    ret: RET.OK,
    ok: validity.ok,
    timestamp: new Date().toISOString(),
    store: rt.store.name,
    missingRequired: validity.ok ? [] : validity.missing.map((m) => ({ key: m.key, label: m.label, group: m.group })),
    configSource: {
      overrides: [...(rt.cfg._overrides || [])],
    },
    checks: {},
  };

  // 存储连通性：写入一个临时键再删除
  try {
    const probeKey = `health:probe:${randomToken(8)}`;
    await rt.store.put(probeKey, { t: now() }, 30);
    const back = await rt.store.get(probeKey);
    await rt.store.delete(probeKey);
    report.checks.store = back ? 'ok' : 'read-after-write-mismatch';
  } catch (e) {
    report.checks.store = `failed: ${e.message}`;
    report.ok = false;
  }

  report.checks.deepseekKey = rt.llm.configured ? 'present' : 'missing';
  report.checks.ilinkToken = rt.ilink.configured ? 'present' : 'missing';
  if (!rt.llm.configured || !rt.ilink.configured) report.ok = false;

  if (deep && rt.llm.configured) {
    try {
      const res = await rt.llm.chat([{ role: 'user', content: 'ping' }], { maxTokens: 8, temperature: 0, retry: false });
      report.checks.deepseek = res.content ? 'ok' : 'empty-response';
    } catch (e) {
      report.checks.deepseek = `failed: ${e.message}`;
      report.ok = false;
    }
  }

  report.latencyMs = now() - t0;
  const cors = corsHeaders(rt.cfg.CORS_ALLOW_ORIGIN || '*');
  const res = json(report, report.ok ? 200 : 503);
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
