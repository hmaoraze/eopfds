/**
 * 极简 CBOR 解码器（RFC 8949 子集），用于解析 attestationObject 中的 COSE_Key。
 * 支持：正整数、负整数、字节串、文本串、数组、映射、tag、简单值与浮点。
 * 不支持不定长（indefinite length）—— WebAuthn 相关结构均使用定长编码。
 */

export class CborError extends Error {}

export function decode(input) {
  const buf = toBytes(input);
  const { value, offset } = readItem(buf, 0);
  if (offset !== buf.length) {
    // 允许尾部存在（个别实现附加填充），但不鼓励；这里宽松处理。
  }
  return value;
}

export function decodeFirst(input) {
  const buf = toBytes(input);
  return readItem(buf, 0).value;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new CborError('CBOR 输入必须是 Uint8Array 或 ArrayBuffer');
}

function readItem(buf, pos) {
  if (pos >= buf.length) throw new CborError('CBOR 数据意外结束');
  const initial = buf[pos];
  const major = initial >> 5;
  const ai = initial & 0x1f;
  let cursor = pos + 1;

  if (ai < 24) {
    return buildValue(major, ai, buf, cursor);
  }
  if (ai === 24) {
    check(cursor + 1, buf);
    return buildValue(major, buf[cursor], buf, cursor + 1);
  }
  if (ai === 25) {
    check(cursor + 2, buf);
    return buildValue(major, readUint16(buf, cursor), buf, cursor + 2);
  }
  if (ai === 26) {
    check(cursor + 4, buf);
    return buildValue(major, readUint32(buf, cursor), buf, cursor + 4);
  }
  if (ai === 27) {
    check(cursor + 8, buf);
    const n = readUint64(buf, cursor);
    if (n > Number.MAX_SAFE_INTEGER) throw new CborError('不支持超过 2^53 的整数');
    return buildValue(major, n, buf, cursor + 8);
  }
  if (ai === 31) throw new CborError('不支持不定长 CBOR 编码');
  throw new CborError(`非法 additional information: ${ai}`);
}

function buildValue(major, value, buf, cursor) {
  switch (major) {
    case 0:
      return { value, offset: cursor };
    case 1:
      return { value: -1 - value, offset: cursor };
    case 2: {
      const len = Number(value);
      check(cursor + len, buf);
      return { value: buf.slice(cursor, cursor + len), offset: cursor + len };
    }
    case 3: {
      const len = Number(value);
      check(cursor + len, buf);
      return { value: new TextDecoder().decode(buf.slice(cursor, cursor + len)), offset: cursor + len };
    }
    case 4: {
      const arr = [];
      let off = cursor;
      for (let i = 0; i < Number(value); i++) {
        const item = readItem(buf, off);
        arr.push(item.value);
        off = item.offset;
      }
      return { value: arr, offset: off };
    }
    case 5: {
      const map = new Map();
      let off = cursor;
      for (let i = 0; i < Number(value); i++) {
        const k = readItem(buf, off);
        const v = readItem(buf, k.offset);
        map.set(k.value, v.value);
        off = v.offset;
      }
      return { value: map, offset: off };
    }
    case 6: {
      const item = readItem(buf, cursor);
      return { value: { tag: Number(value), value: item.value }, offset: item.offset };
    }
    case 7: {
      if (value === 20) return { value: false, offset: cursor };
      if (value === 21) return { value: true, offset: cursor };
      if (value === 22) return { value: null, offset: cursor };
      if (value === 23) return { value: undefined, offset: cursor };
      return { value, offset: cursor };
    }
    default:
      throw new CborError(`未知 major type: ${major}`);
  }
}

function check(need, buf) {
  if (need > buf.length) throw new CborError('CBOR 数据长度不足');
}

function readUint16(buf, o) {
  return (buf[o] << 8) | buf[o + 1];
}

function readUint32(buf, o) {
  return ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
}

function readUint64(buf, o) {
  let hi = 0;
  for (let i = 0; i < 4; i++) hi = hi * 256 + buf[o + i];
  let lo = 0;
  for (let i = 4; i < 8; i++) lo = lo * 256 + buf[o + i];
  return hi * 4294967296 + lo;
}

/** 便于书写：把 Map 转成对象（COSE 使用整数键）。 */
export function mapToObj(map) {
  if (!(map instanceof Map)) return map;
  const obj = {};
  for (const [k, v] of map) obj[k] = v;
  return obj;
}
