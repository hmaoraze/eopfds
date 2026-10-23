import { GROUPS, SCHEMA } from '../src/server/config/schema.js';

function fmtDefault(d) {
  if (d === undefined) return '—';
  if (d === '') return '（空）';
  if (typeof d === 'string') return d.includes('\n') ? '（多行，见下）' : `\`${d}\``;
  if (typeof d === 'boolean') return String(d);
  if (typeof d === 'number') return String(d);
  return `\`${JSON.stringify(d)}\``;
}

const out = [];
out.push('# 配置项说明\n');
out.push('全部配置项单一数据源：`src/server/config/schema.js`。取值优先级：\n');
out.push('```\n管理端写入的 KV 覆盖值  >  环境变量  >  Schema 默认值\n```\n');
out.push('管理端保存后立即对所有新请求生效，**无需重新部署**。\n');
out.push('## 必填项清单\n');
const req = SCHEMA.filter((f) => f.required);
out.push('| 环境变量 | 名称 | 分组 |');
out.push('| --- | --- | --- |');
for (const f of req) {
  const g = GROUPS.find((x) => x.id === f.group);
  out.push(`| \`${f.key}\` | ${f.label} | ${g?.label || f.group} |`);
}
out.push('');
out.push('> `SYSTEM_PROMPT`、`ILINK_BASE_URL`、`STORE_DRIVER`、`KV_BINDING_NAME` 虽带默认值，但 Schema 标记 required，管理端会提示确认。');
out.push('');

const gname = Object.fromEntries(GROUPS.map((g) => [g.id, g]));
const byGroup = new Map();
for (const f of SCHEMA) {
  if (!byGroup.has(f.group)) byGroup.set(f.group, []);
  byGroup.get(f.group).push(f);
}
for (const g of GROUPS) {
  const list = byGroup.get(g.id) || [];
  if (!list.length) continue;
  out.push(`## ${g.label}（\`${g.id}\`）\n`);
  out.push(`> ${g.desc}\n`);
  for (const f of list) {
    const flags = [];
    if (f.required) flags.push('**必填**');
    if (f.type === 'secret') flags.push('脱敏');
    if (f.env) flags.push('可从环境变量读取');
    if (f.dependsOn) flags.push(`仅当 \`${f.dependsOn.key}=${f.dependsOn.value}\``);
    const range = f.min !== undefined || f.max !== undefined ? `，范围 ${f.min ?? '-∞'} ~ ${f.max ?? '+∞'}` : '';
    const opts = f.options ? `，可选 ${f.options.map((o) => `\`${o}\``).join(' / ')}` : '';
    out.push(`### \`${f.key}\` — ${f.label}${flags.length ? `　<span>${flags.join(' · ')}</span>` : ''}\n`);
    out.push(`- 类型：\`${f.type}\`${opts}${range}`);
    out.push(`- 默认值：${fmtDefault(f.default)}`);
    if (f.desc) out.push(`- 说明：${f.desc}`);
    if (f.placeholder) out.push(`- 示例：\`${f.placeholder}\``);
    if (typeof f.default === 'string' && f.default.includes('\n')) {
      out.push('\n```text');
      out.push(f.default);
      out.push('```\n');
    }
    out.push('');
  }
}
console.log(out.join('\n'));
