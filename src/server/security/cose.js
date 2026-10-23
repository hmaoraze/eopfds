/**
 * COSE_Key → WebCrypto CryptoKey。
 *
 * COSE 常用键：
 *   1 kty (1=OKP, 2=EC2, 3=RSA)
 *   3 alg (-7=ES256, -35=ES384, -36=ES512, -257=RS256, -8=EdDSA)
 *   EC2:  -1 crv (1=P-256, 2=P-384, 3=P-521), -2 x, -3 y
 *   OKP:  -1 crv (6=Ed25519), -2 x
 *   RSA:  -1 n, -2 e
 */

import { mapToObj } from './cbor.js';
import { spkiForEC, spkiForRSA, spkiForEd25519, rawSignatureToDer, OID } from './der.js';

export const COSE_ALG = {
  ES256: -7,
  ES384: -35,
  ES512: -36,
  RS256: -257,
  EdDSA: -8,
};

const VERIFY_ALGS = {
  [COSE_ALG.ES256]: { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256', import: { name: 'ECDSA', namedCurve: 'P-256' } },
  [COSE_ALG.ES384]: { name: 'ECDSA', namedCurve: 'P-384', hash: 'SHA-384', import: { name: 'ECDSA', namedCurve: 'P-384' } },
  [COSE_ALG.ES512]: { name: 'ECDSA', namedCurve: 'P-521', hash: 'SHA-512', import: { name: 'ECDSA', namedCurve: 'P-521' } },
  [COSE_ALG.RS256]: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } },
  [COSE_ALG.EdDSA]: { name: 'Ed25519', hash: null, import: { name: 'Ed25519' } },
};

const NAME_BY_ALG = {
  [COSE_ALG.ES256]: 'ES256',
  [COSE_ALG.ES384]: 'ES384',
  [COSE_ALG.ES512]: 'ES512',
  [COSE_ALG.RS256]: 'RS256',
  [COSE_ALG.EdDSA]: 'EdDSA',
};

export function algorithmName(alg) {
  return NAME_BY_ALG[Number(alg)] || `unknown(${alg})`;
}

/**
 * @param {Map|object} coseKey CBOR 解码后的 COSE_Key
 * @returns {Promise<{cryptoKey:CryptoKey, alg:number, format:string, jwk:object, spki:string}>}
 */
export async function importCosePublicKey(coseKeyInput) {
  const key = coseKeyInput instanceof Map ? mapToObj(coseKeyInput) : coseKeyInput;
  const kty = key[1];
  const alg = Number(key[3]);
  if (!VERIFY_ALGS[alg]) throw new Error(`不支持的 COSE 算法 alg=${alg}`);

  let spki;
  switch (kty) {
    case 2: { // EC2
      const crv = key[-1];
      const curveOid = crv === 2 ? OID.secp384r1 : crv === 3 ? OID.secp521r1 : OID.prime256v1;
      spki = spkiForEC(curveOid, key[-2], key[-3]);
      break;
    }
    case 3: { // RSA
      const eBytes = key[-2] instanceof Uint8Array ? key[-2] : new Uint8Array(key[-2] || []);
      const eInt = bytesToInt(eBytes);
      spki = spkiForRSA(key[-1], eInt);
      break;
    }
    case 1: { // OKP (Ed25519)
      if (alg !== COSE_ALG.EdDSA) throw new Error('OKP 仅支持 EdDSA');
      spki = spkiForEd25519(key[-2]);
      break;
    }
    default:
      throw new Error(`不支持的 COSE kty=${kty}`);
  }

  const def = VERIFY_ALGS[alg];
  const cryptoKey = await crypto.subtle.importKey('spki', spki, def.import, true, ['verify']);
  let jwk = null;
  try {
    jwk = await crypto.subtle.exportKey('jwk', cryptoKey);
  } catch { /* 部分运行时不支持导出 jwk */ }

  return { cryptoKey, alg, format: def.name, jwk, spki: bytesToBase64(spki), importAlgorithm: def.import };
}

/** 校验签名 result / assertion 签名。 */
export async function verifySignature({ cryptoKey, alg, signature, signedData }) {
  const def = VERIFY_ALGS[alg];
  if (!def) throw new Error(`不支持的签名算法 alg=${alg}`);

  if (def.name === 'ECDSA') {
    // 不同运行时对 ECDSA 签名的入参格式要求不同：
    //   浏览器 / Cloudflare Workers 期望 DER（SEQUENCE{INTEGER r, INTEGER s}）
    //   Node.js 的 WebCrypto 实现只接受 IEEE P1363 原始拼接（r||s）
    // 两种都尝试一次，保证跨环境可用。
    const alg = { name: 'ECDSA', hash: { name: def.hash } };
    let ok = false;
    try {
      ok = await crypto.subtle.verify(alg, cryptoKey, rawSignatureToDer(signature), signedData);
    } catch { /* 忽略并尝试另一种格式 */ }
    if (!ok) {
      try {
        ok = await crypto.subtle.verify(alg, cryptoKey, signature, signedData);
      } catch { /* 校验失败 */ }
    }
    return ok;
  }
  if (def.name === 'RSASSA-PKCS1-v1_5') {
    return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, cryptoKey, signature, signedData);
  }
  if (def.name === 'Ed25519') {
    // Node < 20 的 WebCrypto 可能不支持 Ed25519，抛出时由调用方给出提示
    try {
      return await crypto.subtle.verify({ name: 'Ed25519' }, cryptoKey, signature, signedData);
    } catch (e) {
      throw new Error(`运行时不支持 Ed25519 校验：${e.message}`);
    }
  }
  throw new Error('未处理的算法');
}

function bytesToInt(bytes) {
  let n = 0;
  for (const b of bytes) n = n * 256 + b;
  return n;
}

function bytesToBase64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? alphabet[b2 & 0x3f] : '=';
  }
  return out;
}
