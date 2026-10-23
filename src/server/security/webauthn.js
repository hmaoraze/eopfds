/**
 * WebAuthn / Passkey 服务端实现（注册 + 认证），纯 Web Crypto。
 *
 * 不依赖 simplewebauthn 等三方库，全部按 W3C WebAuthn L2 自行校验：
 *   - clientDataJSON：type / challenge / origin
 *   - authenticatorData：rpIdHash(sha256(rpId))、UP/UV 标志位、signCount、credentialId、公钥
 *   - signature：authData || sha256(clientDataJSON)
 */

import { b64url, randomBytes, sha256, timingSafeEqual, hex } from '../lib/util.js';
import { decode } from './cbor.js';
import { importCosePublicKey, verifySignature, algorithmName } from './cose.js';

const FLAG_UP = 0x01;   // User Present
const FLAG_UV = 0x04;   // User Verified
const FLAG_AT = 0x40;   // Attested credential data
const FLAG_ED = 0x80;   // Extension data

export class WebAuthnError extends Error {}

// ── 选项构造 ────────────────────────────────────────────────────────────

export function buildRegistrationOptions({ rpId, rpName, userId, userName, challenge, excludeCredentials = [], timeout = 60000, userVerification = 'preferred', residentKey = 'preferred', attestation = 'none' }) {
  return {
    rp: { id: rpId, name: rpName },
    user: {
      id: b64url.encode(new TextEncoder().encode(String(userId))),
      name: String(userName || userId),
      displayName: String(userName || userId),
    },
    challenge: b64url.encode(challenge),
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },   // ES256
      { type: 'public-key', alg: -257 }, // RS256
      { type: 'public-key', alg: -8 },   // EdDSA
    ],
    timeout,
    excludeCredentials: excludeCredentials.map((c) => ({
      type: 'public-key',
      id: c.id,
      transports: c.transports || ['internal', 'hybrid'],
    })),
    authenticatorSelection: {
      residentKey,
      requireResidentKey: residentKey === 'required',
      userVerification,
    },
    attestation,
    extensions: { credProps: true },
  };
}

export function buildAuthenticationOptions({ rpId, challenge, allowCredentials = [], timeout = 60000, userVerification = 'preferred' }) {
  return {
    challenge: b64url.encode(challenge),
    timeout,
    rpId,
    allowCredentials: allowCredentials.map((c) => ({
      type: 'public-key',
      id: c.id,
      transports: c.transports || ['internal', 'hybrid'],
    })),
    userVerification,
  };
}

// ── 解析 ────────────────────────────────────────────────────────────────

function parseClientData(raw) {
  const json = new TextDecoder().decode(raw);
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new WebAuthnError('clientDataJSON 不是合法 JSON');
  }
  return obj;
}

export function parseAuthenticatorData(authData) {
  if (!(authData instanceof Uint8Array) || authData.length < 37) {
    throw new WebAuthnError('authenticatorData 长度不足');
  }
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount = view.getUint32(33, false);
  let offset = 37;
  let credential = null;

  if (flags & FLAG_AT) {
    const aaguid = authData.slice(offset, offset + 16);
    offset += 16;
    const credIdLen = view.getUint16(offset, false);
    offset += 2;
    const credentialId = authData.slice(offset, offset + credIdLen);
    offset += credIdLen;
    let cosePublicKey = null;
    try {
      cosePublicKey = decode(authData.slice(offset));
    } catch (e) {
      throw new WebAuthnError(`COSE 公钥解析失败：${e.message}`);
    }
    credential = { aaguid: hex(aaguid), credentialId, cosePublicKey };
  }

  return {
    rpIdHash,
    flags,
    signCount,
    credential,
    userPresent: Boolean(flags & FLAG_UP),
    userVerified: Boolean(flags & FLAG_UV),
    backupEligible: Boolean(flags & 0x08),
    backupState: Boolean(flags & 0x10),
    hasExtensionData: Boolean(flags & FLAG_ED),
  };
}

function assertClientData(clientData, { type, expectedChallenge, expectedOrigin, expectedRpId }) {
  if (clientData.type !== type) throw new WebAuthnError(`clientData.type 应为 ${type}，实际 ${clientData.type}`);
  if (!clientData.challenge) throw new WebAuthnError('clientData 缺少 challenge');
  const challengeBytes = b64url.decode(clientData.challenge);
  if (!timingSafeEqual(challengeBytes, expectedChallenge)) {
    throw new WebAuthnError('challenge 不匹配');
  }
  const origin = String(clientData.origin || '');
  if (expectedOrigin && origin !== expectedOrigin) {
    throw new WebAuthnError(`origin 不被信任：${origin}`);
  }
  const crossOrigin = clientData.crossOrigin;
  if (crossOrigin !== false && crossOrigin !== undefined) {
    // 允许 undefined（旧实现），但拒绝 true
    if (crossOrigin === true) throw new WebAuthnError('拒绝跨源请求');
  }
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch { /* noop */ }
  if (expectedRpId && host && host !== expectedRpId && !host.endsWith(`.${expectedRpId}`)) {
    throw new WebAuthnError(`origin 主机 ${host} 与 rpId ${expectedRpId} 不匹配`);
  }
}

function assertRpIdHash(authData, rpId) {
  return (async () => {
    const expected = await sha256(rpId);
    if (!timingSafeEqual(authData.rpIdHash, expected)) {
      throw new WebAuthnError('authenticatorData 中的 rpIdHash 与预期不符');
    }
  })();
}

// ── 注册校验 ────────────────────────────────────────────────────────────

/**
 * @param {object} params
 *   credential: { id, rawId, response:{ attestationObject, clientDataJSON, transports? } }
 *   expectedChallenge: Uint8Array
 *   expectedOrigin: string
 *   rpId: string
 *   userVerification: 'required' | 'preferred' | 'discouraged'
 *   quarantinedElements: credentials already registered (防止重复注册同一密钥)
 */
export async function verifyRegistration({ credential, expectedChallenge, expectedOrigin, rpId, userVerification = 'preferred', existingCredentialIds = [] }) {
  if (!credential?.response?.attestationObject) throw new WebAuthnError('缺少 attestationObject');
  const clientDataRaw = b64url.decode(credential.response.clientDataJSON);
  const attObjRaw = b64url.decode(credential.response.attestationObject);

  const clientData = parseClientData(clientDataRaw);
  assertClientData(clientData, { type: 'webauthn.create', expectedChallenge, expectedOrigin, expectedRpId: rpId });

  let attObj;
  try {
    attObj = decode(attObjRaw);
  } catch (e) {
    throw new WebAuthnError(`attestationObject 解析失败：${e.message}`);
  }
  if (!(attObj instanceof Map)) throw new WebAuthnError('attestationObject 格式错误');

  const fmt = attObj.get('fmt') || 'none';
  const authDataRaw = attObj.get('authData');
  if (!(authDataRaw instanceof Uint8Array)) throw new WebAuthnError('缺少 authData');

  const authData = parseAuthenticatorData(authDataRaw);
  await assertRpIdHash(authData, rpId);

  if (!authData.userPresent) throw new WebAuthnError('未检测到用户在场（UP 标志位未置位）');
  if (userVerification === 'required' && !authData.userVerified) {
    throw new WebAuthnError('要求进行用户验证（UV），但认证器未执行');
  }
  if (!authData.credential?.cosePublicKey) throw new WebAuthnError('缺少 attested credential data');

  const credentialId = b64url.encode(authData.credential.credentialId);
  if (credential.id && credential.id !== credentialId) {
    throw new WebAuthnError('credential.id 与 authData 中的凭证 ID 不一致');
  }
  if (existingCredentialIds.includes(credentialId)) {
    throw new WebAuthnError('该密钥已注册，无需重复添加');
  }

  const imported = await importCosePublicKey(authData.credential.cosePublicKey);

  return {
    credentialId,
    transports: credential.response.transports || [],
    publicKeyJwk: imported.jwk,
    publicKeySpki: imported.spki,
    algorithm: imported.alg,
    algorithmName: algorithmName(imported.alg),
    signCount: authData.signCount,
    flags: authData.flags,
    userVerified: authData.userVerified,
    backupEligible: authData.backupEligible,
    backupState: authData.backupState,
    aaguid: authData.credential.aaguid,
    attestationFormat: String(fmt),
  };
}

// ── 认证校验 ────────────────────────────────────────────────────────────

/**
 * @param {object} params
 *   credential: { id, rawId, response:{ authenticatorData, clientDataJSON, signature, userHandle? } }
 *   stored: 已保存的凭据 { credentialId, publicKeyJwk, publicKeySpki, algorithm, signCount }
 */
export async function verifyAuthentication({ credential, stored, expectedChallenge, expectedOrigin, rpId, userVerification = 'preferred' }) {
  if (!credential?.response) throw new WebAuthnError('缺少 response');
  if (stored.credentialId !== credential.id && stored.credentialId !== credential.rawId) {
    throw new WebAuthnError('凭证 ID 与请求不符');
  }

  const clientDataRaw = b64url.decode(credential.response.clientDataJSON);
  const authDataRaw = b64url.decode(credential.response.authenticatorData);
  const signature = b64url.decode(credential.response.signature);

  const clientData = parseClientData(clientDataRaw);
  assertClientData(clientData, { type: 'webauthn.get', expectedChallenge, expectedOrigin, expectedRpId: rpId });

  const authData = parseAuthenticatorData(authDataRaw);
  await assertRpIdHash(authData, rpId);

  if (!authData.userPresent) throw new WebAuthnError('未检测到用户在场（UP 标志位未置位）');
  if (userVerification === 'required' && !authData.userVerified) {
    throw new WebAuthnError('要求进行用户验证（UV），但认证器未执行');
  }
  if (authData.signCount !== 0 && stored.signCount !== undefined && authData.signCount <= stored.signCount) {
    throw new WebAuthnError(`签名计数器异常（上次 ${stored.signCount}，本次 ${authData.signCount}），凭据可能被克隆`);
  }

  const cryptoKey = stored.publicKeyJwk
    ? await crypto.subtle.importKey('jwk', stored.publicKeyJwk, importAlgFor(stored.algorithm), true, ['verify'])
    : await (async () => {
        const imported = await importCosePublicKeyFromSpki(stored.publicKeySpki, stored.algorithm);
        return imported.cryptoKey;
      })();

  const signedData = concat(authDataRaw, await sha256(clientDataRaw));
  const verified = await verifySignature({ cryptoKey, alg: stored.algorithm, signature, signedData });
  if (!verified) throw new WebAuthnError('签名校验失败');

  return {
    credentialId: stored.credentialId,
    signCount: authData.signCount,
    userVerified: authData.userVerified,
    userHandle: credential.response.userHandle ? decodeUserHandle(credential.response.userHandle) : null,
  };
}

function importAlgFor(alg) {
  switch (Number(alg)) {
    case -7: return { name: 'ECDSA', namedCurve: 'P-256' };
    case -35: return { name: 'ECDSA', namedCurve: 'P-384' };
    case -36: return { name: 'ECDSA', namedCurve: 'P-521' };
    case -257: return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    case -8: return { name: 'Ed25519' };
    default: throw new WebAuthnError(`不支持的算法 ${alg}`);
  }
}

function base64ToBytes(text) {
  const clean = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const bin = clean.length % 4 ? clean + '='.repeat(4 - (clean.length % 4)) : clean;
  const out = new Uint8Array(Math.floor((bin.length * 3) / 4));
  let p = 0;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let bitBuf = 0;
  let bitCount = 0;
  for (const ch of bin) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) break;
    bitBuf = (bitBuf << 6) | idx;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[p++] = (bitBuf >> bitCount) & 0xff;
    }
  }
  return out.subarray(0, p);
}

async function importCosePublicKeyFromSpki(spkiBase64, alg) {
  const spki = base64ToBytes(spkiBase64);
  const key = await crypto.subtle.importKey('spki', spki, importAlgFor(alg), true, ['verify']);
  return { cryptoKey: key };
}

function decodeUserHandle(handle) {
  try {
    return new TextDecoder().decode(b64url.decode(handle));
  } catch {
    return null;
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const __internal = { randomChallenge: () => randomBytes(32) };
