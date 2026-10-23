/**
 * 管理端前端 —— 原生 ES Module，无框架依赖。
 *
 * 三段式流程：
 *   1) Gate：选择「临时安全链接」或「Passkey 登录」
 *   2) Setup：用一次性链接注册首个密钥（注册成功即刻登录，链接失效）
 *   3) Console：分组配置 + 密钥管理 + 运维
 */

const API_BASE = new URL('../api/admin', location.href).toString();
const TOKEN_KEY = 'wb_admin_token';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ── WebAuthn 编解码 ────────────────────────────────────────────────────

function b64urlToBuf(input) {
  const pad = input.length % 4 ? '='.repeat(4 - (input.length % 4)) : '';
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const webauthnSupported = Boolean(window.PublicKeyCredential);

// ── 状态 ───────────────────────────────────────────────────────────────

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  boot: null,
  schema: [],
  groups: [],
  values: {},
  meta: {},
  link: readLinkFromUrl(),
  revealSecrets: false,
};

function readLinkFromUrl() {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  return params.get('link') || hash.get('link') || '';
}

// ── API ────────────────────────────────────────────────────────────────

async function api(op, payload = {}, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let res;
  try {
    res = await fetch(API_BASE, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({ op, ...payload }),
    });
  } catch (e) {
    throw new Error(`网络请求失败：${e.message}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`服务端返回异常 HTTP ${res.status}`);
  }
  if (body.ret !== 0) throw new Error(body.errmsg || `请求失败 ret=${body.ret}`);
  return body;
}

function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 4200);
}

function showAlert(sel, message, kind = 'error') {
  const el = $(sel);
  if (!el) return;
  el.textContent = message;
  el.className = `alert ${kind}`;
  el.hidden = !message;
}

function setToken(token) {
  state.token = token || '';
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
  $('#btnLogout').hidden = !token;
}

// ── 视图切换 ───────────────────────────────────────────────────────────

function showView(name) {
  $('#viewGate').hidden = name !== 'gate';
  $('#viewSetup').hidden = name !== 'setup';
  $('#viewConsole').hidden = name !== 'console';
  if (name === 'console') {
    $('#btnLogout').hidden = false;
  } else {
    $('#btnLogout').hidden = true;
  }
}

// ── 启动 ───────────────────────────────────────────────────────────────

async function boot() {
  if (!webauthnSupported && window.isSecureContext) {
    showAlert('#gateAlert', '当前环境不支持 WebAuthn，请使用现代浏览器并通过 HTTPS 访问。');
  }
  try {
    state.boot = await api('bootstrap-state');
  } catch (e) {
    showAlert('#gateAlert', `无法连接服务端：${e.message}`);
    return;
  }
  checkHealth();
  if (state.link) {
    $('#linkToken').value = state.link;
    await useLink(state.link);
    return;
  }
  if (state.token) {
    try {
      await api('session-state');
      await enterConsole();
      return;
    } catch {
      setToken('');
    }
  }
  showView('gate');
}

async function checkHealth() {
  try {
    const res = await fetch(new URL('../api/health', location.href).toString(), { credentials: 'same-origin' });
    const body = await res.json();
    const badge = $('#healthBadge');
    badge.textContent = body.ok ? '服务正常' : '存在未完成配置';
    badge.className = `badge ${body.ok ? 'ok' : 'warn'}`;
    if (!body.ok) badge.title = (body.missingRequired || []).map((m) => m.key).join(', ');
  } catch {
    $('#healthBadge').textContent = '健康检查失败';
    $('#healthBadge').className = 'badge err';
  }
}

// ── Gate ───────────────────────────────────────────────────────────────

async function useLink(raw) {
  const token = String(raw || '').trim();
  if (!token) return showAlert('#gateAlert', '请输入安全链接 Token');
  try {
    const res = await api('link-status', { token });
    if (!res.ok) {
      const reasons = { 'already-used': '该链接已被使用', expired: '链接已过期', 'invalid-or-expired': '链接无效或已过期', 'not-found': '链接不存在' };
      return showAlert('#gateAlert', reasons[res.reason] || `链接不可用：${res.reason}`);
    }
    state.link = token;
    state.linkInfo = res;
    showAlert('#gateAlert', '', 'info');
    showView('setup');
    $('#setupAlert').hidden = true;
  } catch (e) {
    showAlert('#gateAlert', e.message);
  }
}

async function passkeyLogin() {
  showAlert('#gateAlert', '', 'info');
  if (!webauthnSupported) return showAlert('#gateAlert', '浏览器不支持 Passkey');
  try {
    const { options, challengeId } = await api('auth-options');
    const publicKey = prepareCreateOrGet(options, false);
    const credential = await navigator.credentials.get({ publicKey });
    const payload = packAssertion(credential);
    const res = await api('auth-verify', { challengeId, credential: payload });
    setToken(res.adminToken);
    await enterConsole();
    toast('登录成功', 'ok');
  } catch (e) {
    showAlert('#gateAlert', explainWebAuthnError(e));
  }
}

// ── Setup：注册首个密钥 ────────────────────────────────────────────────

async function registerPasskey() {
  if (!webauthnSupported) return showAlert('#setupAlert', '浏览器不支持 Passkey，请更换设备或浏览器');
  if (!state.link) return showAlert('#setupAlert', '安全链接缺失，请返回第一步重新进入');
  showAlert('#setupAlert', '', 'info');
  try {
    const { options, challengeId } = await api('register-options', { token: state.link });
    const publicKey = prepareCreateOrGet(options, true);
    const credential = await navigator.credentials.create({ publicKey });
    const payload = packAttestation(credential);
    const res = await api('register-verify', {
      challengeId,
      credential: payload,
      displayName: $('#setupName').value.trim() || '管理员',
    });
    setToken(res.adminToken);
    state.link = '';
    if (location.search.includes('link=')) {
      history.replaceState({}, '', location.pathname);
    }
    await enterConsole();
    toast('密钥注册成功，已进入配置中心', 'ok');
  } catch (e) {
    showAlert('#setupAlert', explainWebAuthnError(e));
  }
}

// ── WebAuthn 负载准备 ──────────────────────────────────────────────────

function prepareCreateOrGet(options, isCreate) {
  const pk = { ...options };
  pk.challenge = b64urlToBuf(options.challenge);
  if (isCreate) {
    pk.user = { ...options.user, id: b64urlToBuf(options.user.id) };
    pk.excludeCredentials = (options.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) }));
  } else {
    pk.allowCredentials = (options.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) }));
  }
  return pk;
}

function packAttestation(cred) {
  return {
    id: cred.id,
    rawId: cred.rawId ? bufToB64url(cred.rawId) : cred.id,
    type: cred.type || 'public-key',
    response: {
      attestationObject: bufToB64url(cred.response.attestationObject),
      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
  };
}

function packAssertion(cred) {
  return {
    id: cred.id,
    rawId: cred.rawId ? bufToB64url(cred.rawId) : cred.id,
    type: cred.type || 'public-key',
    response: {
      authenticatorData: bufToB64url(cred.response.authenticatorData),
      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      signature: bufToB64url(cred.response.signature),
      userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
    },
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
  };
}

function explainWebAuthnError(e) {
  const name = e?.name || '';
  if (name === 'NotAllowedError') return '操作被取消或超时，请重试并完成 biometric/PIN 验证';
  if (name === 'InvalidStateError') return '该密钥已在本设备中注册过了';
  if (name === 'SecurityError') return '域名不被允许，请检查 ADMIN_RP_ID 与访问域名是否一致';
  return e?.message || String(e);
}

// ── Console ────────────────────────────────────────────────────────────

async function enterConsole() {
  showView('console');
  const [{ schema, groups }, cfg] = await Promise.all([api('schema'), api('config-get')]);
  state.schema = schema;
  state.groups = groups;
  state.values = cfg.values;
  state.meta = cfg.meta;
  renderNav();
  renderConfig();
  selectTab('wechat');
  await refreshRequiredBanner(cfg.validity);
}

function renderNav() {
  const nav = $('#navGroups');
  nav.innerHTML = '<div class="side-title">配置项</div>';
  for (const g of state.groups) {
    const btn = document.createElement('button');
    btn.className = 'side-item';
    btn.dataset.tab = g.id;
    btn.textContent = g.label;
    const missing = state.schema.filter((f) => f.group === g.id && f.required);
    if (missing.some((f) => isBlank(state.values[f.key]))) {
      const dot = document.createElement('em');
      dot.className = 'req-dot';
      dot.textContent = '！';
      dot.title = '含未填写的必填项';
      btn.appendChild(dot);
    }
    nav.appendChild(btn);
  }
  $$('.side-item').forEach((el) => el.addEventListener('click', () => selectTab(el.dataset.tab)));
}

function selectTab(tab) {
  $$('.side-item').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  const isConfigTab = state.groups.some((g) => g.id === tab);
  $('#tabConfig').hidden = !isConfigTab;
  for (const id of ['keys', 'security', 'wechat-login', 'memory', 'sessions', 'audit']) {
    $(`#tab${tabNameToId(id)}`).hidden = tab !== id;
  }
  if (isConfigTab) {
    const target = document.getElementById(`group-${tab}`);
    if (target) {
      document.querySelectorAll('.group').forEach((g) => { g.classList.remove('folded'); });
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  if (tab === 'keys') refreshKeys();
  if (tab === 'audit') refreshAudit();
}

function tabNameToId(name) {
  return { keys: 'Keys', security: 'Security', 'wechat-login': 'WechatLogin', memory: 'Memory', sessions: 'Sessions', audit: 'Audit' }[name] || name;
}

function isBlank(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '' || v.includes('***');
  return false;
}

function isVisible(field) {
  if (!field.dependsOn) return true;
  return String(state.values[field.dependsOn.key]) === String(field.dependsOn.value);
}

function renderConfig() {
  const host = $('#configGroups');
  host.innerHTML = '';
  for (const group of state.groups) {
    const fields = state.schema.filter((f) => f.group === group.id);
    if (!fields.length) continue;
    const section = document.createElement('section');
    section.className = 'group';
    section.id = `group-${group.id}`;
    const head = document.createElement('div');
    head.className = 'group-head';
    head.innerHTML = `<h3>${escapeHtml(group.label)}</h3><p class="muted">${escapeHtml(group.desc || '')}</p>`;
    section.appendChild(head);

    for (const field of fields) {
      section.appendChild(renderField(field));
    }
    host.appendChild(section);
  }
  $$('[data-field]').forEach((input) => {
    input.addEventListener('change', onFieldChange);
    input.addEventListener('input', onFieldChange);
  });
}

function onFieldChange(e) {
  const key = e.target.dataset.field;
  const field = state.schema.find((f) => f.key === key);
  if (!field) return;
  let value;
  if (field.type === 'boolean') value = e.target.checked;
  else if (field.type === 'number') value = Number(e.target.value);
  else value = e.target.value;
  state.values[key] = value;
  if (field.dependsOn) {
    renderNav();
    renderConfig();
    return;
  }
  updateRequiredMarks();
}

function renderField(field) {
  const wrap = document.createElement('div');
  wrap.className = 'field-row';
  if (!isVisible(field)) wrap.classList.add('hidden');

  const label = document.createElement('label');
  label.className = 'field-label';
  const requiredMark = field.required ? '<span class="req" title="必填">*</span>' : '<span class="opt">选填</span>';
  label.innerHTML = `<span class="name">${escapeHtml(field.label)}${requiredMark}</span><code>${escapeHtml(field.key)}</code>`;
  wrap.appendChild(label);

  const control = document.createElement('div');
  control.className = 'field-control';
  const current = state.values[field.key];
  const masked = state.meta[field.key]?.masked;
  const source = state.meta[field.key]?.source;

  let input;
  switch (field.type) {
    case 'boolean':
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(current);
      break;
    case 'textarea':
      input = document.createElement('textarea');
      input.rows = field.rows || 6;
      input.value = current ?? '';
      break;
    case 'number':
      input = document.createElement('input');
      input.type = 'number';
      input.value = current ?? '';
      if (typeof field.min === 'number') input.min = field.min;
      if (typeof field.max === 'number') input.max = field.max;
      break;
    case 'select':
      input = document.createElement('select');
      for (const opt of field.options || []) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        o.selected = String(current) === String(opt);
        input.appendChild(o);
      }
      break;
    case 'json':
      input = document.createElement('textarea');
      input.rows = 4;
      input.value = typeof current === 'object' ? JSON.stringify(current, null, 2) : String(current ?? '');
      break;
    case 'secret':
      input = document.createElement('input');
      input.type = state.revealSecrets ? 'text' : 'password';
      input.value = state.revealSecrets ? (current ?? '') : (current ?? '');
      input.autocomplete = 'new-password';
      input.placeholder = field.placeholder || (masked ? '已保存，留空保持不变' : '');
      break;
    default:
      input = document.createElement('input');
      input.type = 'text';
      input.value = current ?? '';
      input.placeholder = field.placeholder || '';
  }
  input.dataset.field = field.key;
  input.id = `f-${field.key}`;
  control.appendChild(input);

  if (field.type === 'secret' && masked) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'link-btn';
    toggle.textContent = '修改';
    toggle.addEventListener('click', () => {
      input.value = '';
      input.type = 'text';
      input.focus();
      input.dataset.touched = '1';
    });
    control.appendChild(toggle);
  }

  const hint = document.createElement('p');
  hint.className = 'field-desc';
  const tags = [];
  if (source === 'store') tags.push('<em class="tag">已由管理端覆盖</em>');
  else tags.push('<em class="tag muted">来源：环境变量 / 默认值</em>');
  hint.innerHTML = `${escapeHtml(field.desc || '')}${tags.join(' ')}`;
  control.appendChild(hint);

  wrap.appendChild(control);
  return wrap;
}

function updateRequiredMarks() {
  const missing = state.schema.filter((f) => f.required && isBlank(state.values[f.key]));
  const banner = $('#requiredBanner');
  banner.hidden = missing.length === 0;
  if (missing.length) {
    $('#requiredList').textContent = missing.map((f) => f.label).join(' · ');
  }
  return missing;
}

async function refreshRequiredBanner(validity) {
  const missing = state.schema.filter((f) => f.required && (validity?.missing || []).some((m) => m.key === f.key));
  updateRequiredMarks();
  return missing;
}

async function saveConfig() {
  const missing = updateRequiredMarks();
  const values = {};
  for (const field of state.schema) {
    if (!isVisible(field)) continue;
    const el = document.getElementById(`f-${field.key}`);
    if (!el) continue;
    if (field.type === 'secret') {
      const touched = el.dataset.touched === '1';
      const changed = el.value !== state.values[field.key];
      if (touched || (changed && !String(el.value).includes('***'))) values[field.key] = el.value;
      continue;
    }
    values[field.key] = field.type === 'boolean'
      ? el.checked
      : field.type === 'number'
        ? Number(el.value)
        : el.value;
  }
  if (missing.length) {
    toast(`请先填写必填项：${missing.map((f) => f.label).join('、')}`, 'warn');
    return;
  }
  const state_ = $('#saveState');
  state_.textContent = '保存中…';
  try {
    const res = await api('config-save', { values });
    state_.textContent = res.valid ? '已保存，立即生效' : `已保存，但仍有缺失：${res.missingRequired.map((m) => m.label).join('、')}`;
    state_.className = res.valid ? 'save-state ok' : 'save-state warn';
    await reloadConfig();
    await checkHealth();
  } catch (e) {
    state_.textContent = `保存失败：${e.message}`;
    state_.className = 'save-state err';
  }
}

async function reloadConfig() {
  try {
    const cfg = await api('config-get', { reveal: state.revealSecrets ? '1' : '0' });
    state.values = cfg.values;
    state.meta = cfg.meta;
    renderNav();
    renderConfig();
  } catch (e) {
    toast(`配置刷新失败：${e.message}`, 'warn');
  }
}

async function toggleReveal() {
  if (state.revealSecrets) {
    state.revealSecrets = false;
    $('#btnReveal').textContent = '显示密钥明文';
    await reloadConfig();
    return;
  }
  try {
    const reauthToken = await stepUp();
    state.revealSecrets = true;
    $('#btnReveal').textContent = '隐藏密钥明文';
    const cfg = await api('config-get', { reveal: '1', reauthToken });
    state.values = cfg.values;
    state.meta = cfg.meta;
    renderConfig();
    toast('已显示密钥明文，请勿截图或分享', 'warn');
  } catch (e) {
    toast(`无法显示明文：${explainWebAuthnError(e)}`, 'warn');
  }
}

// ── 密钥管理 ───────────────────────────────────────────────────────────

async function refreshKeys() {
  try {
    const { passkeys } = await api('passkeys-list');
    const tbody = $('#keysTable tbody');
    tbody.innerHTML = '';
    if (!passkeys.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">尚未注册密钥</td></tr>';
      return;
    }
    for (const k of passkeys) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(k.displayName || '未命名')}</td>
        <td><code>${escapeHtml(k.id.slice(0, 12))}…</code></td>
        <td>${escapeHtml(k.algorithmName || '-')}</td>
        <td>${new Date(k.createdAt).toLocaleString('zh-CN')}</td>
        <td>${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('zh-CN') : '—'}</td>
        <td><button class="btn tiny danger-ghost" data-del="${escapeHtml(k.id)}">删除</button></td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await removeWithReauth(btn.dataset.del);
        } catch (e) { toast(e.message, 'warn'); }
      });
    });
  } catch (e) {
    toast(`加载密钥失败：${e.message}`, 'warn');
  }
}

async function removeWithReauth(credentialId) {
  if (!confirm('确认删除该密钥？删除后该设备将无法登录管理端。')) return;
  const reauthToken = await stepUp();
  await api('passkey-remove', { credentialId, reauthToken });
  toast('密钥已删除', 'ok');
  await refreshKeys();
}

async function addPasskey() {
  try {
    const { options, challengeId } = await api('passkey-add-options');
    const credential = await navigator.credentials.create({ publicKey: prepareCreateOrGet(options, true) });
    await api('register-verify', { challengeId, credential: packAttestation(credential), displayName: `${navigator.platform || '新设备'} 密钥` });
    toast('新密钥已添加', 'ok');
    await refreshKeys();
  } catch (e) {
    toast(explainWebAuthnError(e), 'warn');
  }
}

async function resetPasskeys() {
  if (!confirm('将清空全部密钥并退出登录。确认继续？')) return;
  try {
    const reauthToken = await stepUp();
    await api('reset-passkeys', { reauthToken });
  } catch (e) {
    toast(e.message, 'warn');
    return;
  }
  setToken('');
  location.href = location.pathname;
}

/** 敏感操作前重新做一次 Passkey 断言，换取一次性 reauth 令牌。 */
async function stepUp() {
  if (!webauthnSupported) throw new Error('浏览器不支持 Passkey');
  const { options, challengeId } = await api('reauth-options');
  const assertion = await navigator.credentials.get({ publicKey: prepareCreateOrGet(options, false) });
  const res = await api('auth-verify', { challengeId, purpose: 'reauth', credential: packAssertion(assertion) });
  if (!res.reauthToken) throw new Error('重新验证未通过');
  return res.reauthToken;
}

// ── 运维面板 ───────────────────────────────────────────────────────────

async function issueSecureLink() {
  try {
    const reauthToken = await stepUp();
    const res = await api('issue-secure-link', { purpose: $('#linkPurpose').value, reauthToken });
    const box = $('#issuedLink');
    box.hidden = false;
    box.innerHTML = `<div>有效期至 ${new Date(res.expiresAt).toLocaleString('zh-CN')}（仅一次使用）</div><code>${escapeHtml(res.url)}</code><button class="btn tiny" id="btnCopyLink">复制</button>`;
    $('#btnCopyLink').addEventListener('click', async () => {
      await navigator.clipboard.writeText(res.url).catch(() => {});
      toast('链接已复制', 'ok');
    });
  } catch (e) {
    toast(`签发失败：${explainWebAuthnError(e)}`, 'warn');
  }
}

let currentQr = '';
async function getQrcode() {
  try {
    const res = await api('ilink-qrcode');
    currentQr = res.qrcode;
    $('#qrBox').hidden = false;
    $('#qrImg').src = res.qrcodeImg;
    $('#btnPoll').disabled = false;
  } catch (e) {
    toast(`获取二维码失败：${e.message}`, 'warn');
  }
}

async function pollQr() {
  if (!currentQr) return;
  try {
    const res = await api('ilink-qrstatus', { qrcode: currentQr });
    const box = $('#qrStatus');
    box.hidden = false;
    box.textContent = `状态：${res.status}${res.botTokenReceived ? ' —— 已获取 Bot Token 并自动写入配置' : ''}`;
    if (res.needVerifyCode) {
      const code = prompt('请输入微信显示的配对码');
      if (code) await api('ilink-qrstatus', { qrcode: currentQr, verifyCode: code });
    }
    if (res.botTokenReceived) toast('iLink Bot Token 已写入配置', 'ok');
  } catch (e) {
    toast(`轮询失败：${e.message}`, 'warn');
  }
}

async function loadMemory() {
  const userId = $('#memUser').value.trim();
  if (!userId) return toast('请输入用户 ID', 'warn');
  try {
    const res = await api('memory-list', { userId, query: $('#memQuery').value.trim() });
    const tbody = $('#memTable tbody');
    tbody.innerHTML = '';
    for (const item of res.items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(item.content)}</td>
        <td>${escapeHtml(item.category || '')}</td>
        <td>${item.importance ?? ''}</td>
        <td>${item.score ? item.score.toFixed(3) : ''}</td>
        <td>${new Date(item.updatedAt).toLocaleString('zh-CN')}</td>
        <td><button class="btn tiny danger-ghost" data-mem="${escapeHtml(item.id)}">删除</button></td>`;
      tbody.appendChild(tr);
    }
    tbody.querySelectorAll('[data-mem]').forEach((b) => b.addEventListener('click', async () => {
      await api('memory-delete', { userId, memoryId: b.dataset.mem });
      await loadMemory();
    }));
    const s = res.stats;
    $('#memStats').hidden = false;
    $('#memStats').innerHTML = `<span>条数 ${s.total}/${s.limit}</span><span>字符 ${s.chars}</span><span>待清理过期 ${s.expiredPending}</span>`;
  } catch (e) {
    toast(`加载失败：${e.message}`, 'warn');
  }
}

async function loadSessions() {
  const userId = $('#sessUser').value.trim();
  if (!userId) return toast('请输入用户 ID', 'warn');
  try {
    const res = await api('session-list', { userId });
    const tbody = $('#sessTable tbody');
    tbody.innerHTML = '';
    for (const s of res.sessions) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><code>${escapeHtml(s.sessionId)}</code></td><td>${s.state}</td><td>${s.turn}</td>
        <td>${new Date(s.createdAt).toLocaleString('zh-CN')}</td><td>${s.expiresAt ? new Date(s.expiresAt).toLocaleString('zh-CN') : '—'}</td>
        <td>${escapeHtml(s.endReason || '')}</td>`;
      tbody.appendChild(tr);
    }
    if (!res.sessions.length) tbody.innerHTML = '<tr><td colspan="6" class="muted">暂无会话记录</td></tr>';
  } catch (e) {
    toast(`加载失败：${e.message}`, 'warn');
  }
}

async function refreshAudit() {
  try {
    const res = await api('audit-list');
    const tbody = $('#auditTable tbody');
    tbody.innerHTML = '';
    for (const item of res.items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${new Date(item.ts).toLocaleString('zh-CN')}</td><td>${escapeHtml(item.action || '')}</td><td>${escapeHtml(item.ip || '')}</td><td><code>${escapeHtml(JSON.stringify(item).slice(0, 120))}</code></td>`;
      tbody.appendChild(tr);
    }
    if (!res.items.length) tbody.innerHTML = '<tr><td colspan="4" class="muted">暂无日志</td></tr>';
  } catch (e) {
    toast(`加载失败：${e.message}`, 'warn');
  }
}

// ── 工具 ───────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── 事件绑定 ───────────────────────────────────────────────────────────

export function initEvents() {
  $('#btnUseLink').addEventListener('click', () => useLink($('#linkToken').value));
  $('#btnPasskeyLogin').addEventListener('click', passkeyLogin);
  $('#btnRegister').addEventListener('click', registerPasskey);
  $('#btnSave').addEventListener('click', saveConfig);
  $('#btnReveal').addEventListener('click', toggleReveal);
  $('#btnLogout').addEventListener('click', async () => {
    try { await api('logout'); } catch { /* noop */ }
    setToken('');
    location.href = location.pathname;
  });
  $('#btnAddKey').addEventListener('click', addPasskey);
  $('#btnResetKeys').addEventListener('click', resetPasskeys);
  $('#btnIssueLink').addEventListener('click', issueSecureLink);
  $('#btnQrcode').addEventListener('click', getQrcode);
  $('#btnPoll').addEventListener('click', pollQr);
  $('#btnMemLoad').addEventListener('click', loadMemory);
  $('#btnMemPurge').addEventListener('click', async () => {
    const userId = $('#memUser').value.trim();
    if (!userId || !confirm(`确认清空 ${userId} 的全部记忆？`)) return;
    await api('memory-purge', { userId });
    await loadMemory();
  });
  $('#btnSessLoad').addEventListener('click', loadSessions);
  $('#btnSessEnd').addEventListener('click', async () => {
    const userId = $('#sessUser').value.trim();
    if (!userId) return toast('请输入用户 ID', 'warn');
    const res = await api('session-end', { userId });
    toast(res.ended ? '会话已结束并提炼记忆' : '没有活跃会话', res.ended ? 'ok' : 'warn');
    await loadSessions();
  });
  $('#btnSweep').addEventListener('click', async () => {
    const res = await api('sweep');
    $('#sweepOut').hidden = false;
    $('#sweepOut').textContent = `扫描 ${res.scanned} 条，回收 ${res.expired} 个会话，写入 ${res.memories} 条记忆`;
  });
  $('#btnAudit').addEventListener('click', refreshAudit);
}

export function init() {
  initEvents();
  boot();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
