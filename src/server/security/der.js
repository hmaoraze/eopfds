/**
 * DER / 公钥编码工具（WebAuthn 服务端校验需要构造 SPKI）。
 * 仅做编码，不做解析。
 */

import { hex, concatBytes } from '../lib/util.js';

const OID = {
  // iso.org.dod.internet
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecPublicKey: '1.2.840.10045.2.1',
  prime256v1: '1.2.840.10045.3.1.7',
  secp384r1: '1.3.132.0.34',
  secp521r1: '1.3.132.0.35',
  ed25519: '1.3.101.112',
};

export function encodeLength(len) {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag, content) {
  return concatBytes(new Uint8Array([tag]), encodeLength(content.length), content);
}

export function sequence(...parts) {
  return tlv(0x30, concatBytes(...parts));
}

export function bitString(bytes, unusedBits = 0) {
  return tlv(0x03, concatBytes(new Uint8Array([unusedBits]), bytes));
}

export function objectIdentifier(dotted) {
  const parts = String(dotted).split('.').map(Number);
  const body = [parts[0] * 40 + parts[1]];
  for (const v of parts.slice(2)) {
    if (v < 0x80) {
      body.push(v);
    } else {
      const tmp = [];
      let n = v;
      while (n > 0) {
        tmp.unshift(n & 0x7f);
        n = Math.floor(n / 128);
      }
      tmp[tmp.length - 1] |= 0x00;
      for (let i = 0; i < tmp.length - 1; i++) tmp[i] |= 0x80;
      body.push(...tmp);
    }
  }
  return tlv(0x06, new Uint8Array(body));
}

export function nullValue() {
  return new Uint8Array([0x05, 0x00]);
}

export function positiveInteger(bytes) {
  // INTEGER 必须是最小二补码形式
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let value = bytes.slice(start);
  if (value[0] & 0x80) value = concatBytes(new Uint8Array([0x00]), value);
  return tlv(0x02, value);
}

export function derNullParams() {
  return nullValue();
}

/** EC 公钥 SPKI（X9.62 uncompressed point）。 */
export function spkiForEC(curveOid, xBytes, yBytes) {
  const coordinateLength = curveOid === OID.secp521r1 ? 66 : curveOid === OID.secp384r1 ? 48 : 32;
  const x = padLeft(xBytes, coordinateLength);
  const y = padLeft(yBytes, coordinateLength);
  const point = concatBytes(new Uint8Array([0x04]), x, y);
  return sequence(
    sequence(objectIdentifier(OID.ecPublicKey), objectIdentifier(curveOid)),
    bitString(point),
  );
}

/** RSA 公钥 SPKI。 */
export function spkiForRSA(nBytes, eInt) {
  const e = new Uint8Array(4);
  e[0] = (eInt >>> 24) & 0xff;
  e[1] = (eInt >>> 16) & 0xff;
  e[2] = (eInt >>> 8) & 0xff;
  e[3] = eInt & 0xff;
  let eTrim = e;
  let start = 0;
  while (start < eTrim.length - 1 && eTrim[start] === 0) start++;
  eTrim = eTrim.slice(start);

  const pkcs1 = sequence(positiveInteger(nBytes), positiveInteger(eTrim));
  return sequence(
    sequence(objectIdentifier(OID.rsaEncryption), derNullParams()),
    bitString(pkcs1),
  );
}

/** Ed25519 公钥 SPKI。 */
export function spkiForEd25519(rawKey) {
  return sequence(
    sequence(objectIdentifier(OID.ed25519)),
    bitString(rawKey),
  );
}

function padLeft(bytes, len) {
  if (bytes.length === len) return bytes;
  if (bytes.length > len) return bytes.slice(bytes.length - len);
  return concatBytes(new Uint8Array(len - bytes.length), bytes);
}

/** ECDSA 原始签名 (r||s) → DER SEQUENCE{INTEGER(r), INTEGER(s)}。 */
export function rawSignatureToDer(rawSig) {
  const half = Math.floor(rawSig.length / 2);
  return sequence(positiveInteger(rawSig.slice(0, half)), positiveInteger(rawSig.slice(half)));
}

export { OID, hex };
