/** Tiny ZIP (STORE writer, STORE + deflate-raw reader). No dependencies. */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const VERSION = 20;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

/** IEEE CRC-32. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i] ?? 0;
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class ZipError extends Error {
  constructor(message = 'bad zip') {
    super(message);
    this.name = 'ZipError';
  }
}

export type ZipEntry = { name: string; data: Uint8Array };

export type ZipWrite = {
  name: string;
  /** Uncompressed bytes. CRC is always of these. */
  data: Uint8Array;
  method?: 0 | 8;
  /** Required when method is deflate (8). */
  compressed?: Uint8Array;
};

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const time =
    (d.getUTCHours() << 11) |
    (d.getUTCMinutes() << 5) |
    (d.getUTCSeconds() >> 1);
  const date =
    ((d.getUTCFullYear() - 1980) << 9) |
    ((d.getUTCMonth() + 1) << 5) |
    d.getUTCDate();
  return { time, date };
}

function write16(view: DataView, at: number, value: number): number {
  view.setUint16(at, value & 0xffff, true);
  return at + 2;
}

function write32(view: DataView, at: number, value: number): number {
  view.setUint32(at, value >>> 0, true);
  return at + 4;
}

/**
 * Writes a ZIP. `zipStore` is the STORE-only helper the export uses.
 * Method 8 exists so tests (and a hand-built archive) can exercise the reader.
 *
 * One allocation, one pass for sizes and one for bytes: the previous version copied
 * every table into a local chunk and then copied all chunks again, which tripled the
 * memory needed for a large shop export.
 */
export function writeZip(
  files: readonly ZipWrite[],
  now = Date.now(),
): Uint8Array {
  if (files.length > 0xffff) throw new ZipError('too many files');
  const stamp = dosTime(now);
  const encoder = new TextEncoder();
  const prepared = files.map((file) => {
    const method = file.method ?? 0;
    const compressed = method === 0 ? file.data : file.compressed;
    if (compressed === undefined) throw new ZipError('missing deflate bytes');
    if (file.data.length > 0xffffffff || compressed.length > 0xffffffff) {
      throw new ZipError('file too large');
    }
    const name = encoder.encode(file.name);
    if (name.length > 0xffff) throw new ZipError('name too long');
    return {
      method,
      compressed,
      rawSize: file.data.length,
      crc: crc32(file.data),
      name,
      offset: 0,
    };
  });
  const localSize = prepared.reduce(
    (sum, file) => sum + 30 + file.name.length + file.compressed.length,
    0,
  );
  const centralSize = prepared.reduce(
    (sum, file) => sum + 46 + file.name.length,
    0,
  );
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let at = 0;
  for (const file of prepared) {
    file.offset = at;
    at = write32(view, at, SIG_LOCAL);
    at = write16(view, at, VERSION);
    at = write16(view, at, FLAG_UTF8);
    at = write16(view, at, file.method);
    at = write16(view, at, stamp.time);
    at = write16(view, at, stamp.date);
    at = write32(view, at, file.crc);
    at = write32(view, at, file.compressed.length);
    at = write32(view, at, file.rawSize);
    at = write16(view, at, file.name.length);
    at = write16(view, at, 0);
    out.set(file.name, at);
    at += file.name.length;
    out.set(file.compressed, at);
    at += file.compressed.length;
  }
  const centralStart = at;
  for (const file of prepared) {
    at = write32(view, at, SIG_CENTRAL);
    at = write16(view, at, VERSION);
    at = write16(view, at, VERSION);
    at = write16(view, at, FLAG_UTF8);
    at = write16(view, at, file.method);
    at = write16(view, at, stamp.time);
    at = write16(view, at, stamp.date);
    at = write32(view, at, file.crc);
    at = write32(view, at, file.compressed.length);
    at = write32(view, at, file.rawSize);
    at = write16(view, at, file.name.length);
    at = write16(view, at, 0);
    at = write16(view, at, 0);
    at = write16(view, at, 0);
    at = write16(view, at, 0);
    at = write32(view, at, 0);
    at = write32(view, at, file.offset);
    out.set(file.name, at);
    at += file.name.length;
  }
  at = write32(view, at, SIG_EOCD);
  at = write16(view, at, 0);
  at = write16(view, at, 0);
  at = write16(view, at, files.length);
  at = write16(view, at, files.length);
  at = write32(view, at, at - 12 - centralStart);
  at = write32(view, at, centralStart);
  write16(view, at, 0);
  return out;
}

/** STORE-method ZIP used for operator exports. */
export function zipStore(
  files: readonly ZipEntry[],
  now = Date.now(),
): Uint8Array {
  return writeZip(
    files.map((file) => ({ name: file.name, data: file.data, method: 0 })),
    now,
  );
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEocd(bytes: Uint8Array): number {
  const view = viewOf(bytes);
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) !== SIG_EOCD) continue;
    const comment = view.getUint16(i + 20, true);
    if (i + 22 + comment === bytes.length) return i;
  }
  throw new ZipError();
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  await writer.write(data as Uint8Array<ArrayBuffer>);
  await writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

async function readEntry(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compSize: number,
  rawSize: number,
  crc: number,
): Promise<Uint8Array> {
  if (localOffset + 30 > bytes.length) throw new ZipError();
  if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw new ZipError();
  const nameLen = view.getUint16(localOffset + 26, true);
  const extraLen = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLen + extraLen;
  const end = start + compSize;
  if (end > bytes.length) throw new ZipError();
  const compressed = bytes.subarray(start, end);
  let data: Uint8Array;
  if (method === 0) data = compressed.slice();
  else if (method === 8) data = await inflateRaw(compressed);
  else throw new ZipError('unsupported method');
  if (data.length !== rawSize) throw new ZipError('size mismatch');
  if (crc32(data) !== crc) throw new ZipError('crc mismatch');
  return data;
}

/** Reads STORE and deflate-raw entries. ZIP64 is refused. */
export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const eocd = findEocd(bytes);
  const view = viewOf(bytes);
  const count = view.getUint16(eocd + 8, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset > bytes.length || cdSize > bytes.length - cdOffset) {
    throw new ZipError();
  }
  const out: ZipEntry[] = [];
  let p = cdOffset;
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > bytes.length) throw new ZipError();
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError();
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const rawSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (
      compSize === 0xffffffff ||
      rawSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new ZipError('zip64');
    }
    const nameStart = p + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > bytes.length) throw new ZipError();
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    p = nameEnd + extraLen + commentLen;
    const data = await readEntry(
      bytes,
      view,
      localOffset,
      method,
      compSize,
      rawSize,
      crc,
    );
    out.push({ name, data });
  }
  return out;
}
