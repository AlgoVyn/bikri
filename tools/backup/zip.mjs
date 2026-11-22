/** Minimal STORE-only ZIP writer for the backup tools (no dependencies). */
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const VERSION = 20;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1)
    crc = (CRC_TABLE[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function zipStore(files, now = Date.now()) {
  if (files.length > 0xffff)
    throw new RangeError('ZIP32 supports at most 65,535 entries');
  const stamp = new Date(now);
  // DOS dates cannot represent years outside 1980–2107. Clamp instead of letting a
  // pre-1980 clock wrap the year field.
  const year = Math.min(127, Math.max(0, stamp.getUTCFullYear() - 1980));
  const month = Math.min(12, Math.max(1, stamp.getUTCMonth() + 1));
  const day = Math.min(31, Math.max(1, stamp.getUTCDate()));
  const time =
    (stamp.getUTCHours() << 11) |
    (stamp.getUTCMinutes() << 5) |
    (stamp.getUTCSeconds() >> 1);
  const date = (year << 9) | (month << 5) | day;
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    if (name.length > 0xffff)
      throw new RangeError(`ZIP entry name is too long: ${file.name}`);
    if (file.data.length > 0xfffffffe)
      throw new RangeError(`ZIP entry is too large (ZIP32): ${file.name}`);
    const crc = crc32(file.data);
    const local = concat([
      u32(SIG_LOCAL),
      u16(VERSION),
      u16(FLAG_UTF8),
      u16(0),
      u16(time),
      u16(date),
      u32(crc),
      u32(file.data.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      name,
      file.data,
    ]);
    locals.push(local);
    centrals.push(
      concat([
        u32(SIG_CENTRAL),
        u16(VERSION),
        u16(VERSION),
        u16(FLAG_UTF8),
        u16(0),
        u16(time),
        u16(date),
        u32(crc),
        u32(file.data.length),
        u32(file.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const central = concat(centrals);
  if (offset > 0xfffffffe || central.length > 0xfffffffe)
    throw new RangeError('ZIP32 archive is too large');
  const end = concat([
    u32(SIG_EOCD),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, central, end]);
}
