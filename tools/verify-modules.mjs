import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

let bad = 0;
for (const f of [...walk('src/server'), ...walk('edge-functions')]) {
  const url = new URL(`file:///${process.cwd()}/${f}`.replace(/\\/g, '/'));
  try {
    await import(url.href);
    console.log('  ok  ', f);
  } catch (e) {
    bad++;
    console.log('  FAIL', f, '→', e.message);
  }
}
console.log(bad ? `\n${bad} 个模块导入失败` : '\n全部模块导入正常');
process.exit(bad ? 1 : 0);
