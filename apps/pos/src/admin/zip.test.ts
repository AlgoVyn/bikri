import {
  CompressionStream as NodeCompressionStream,
  DecompressionStream as NodeDecompressionStream,
} from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import {
  crc32,
  MAX_ENTRY_BYTES,
  unzip,
  writeZip,
  ZipError,
  ZipStoreWriter,
  zipStore,
  zipStoreBlob,
} from './zip.ts';

if (typeof globalThis.CompressionStream === 'undefined') {
  Object.assign(globalThis, { CompressionStream: NodeCompressionStream });
}
if (typeof globalThis.DecompressionStream === 'undefined') {
  Object.assign(globalThis, { DecompressionStream: NodeDecompressionStream });
}

const text = new TextEncoder();

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const transform = new CompressionStream('deflate-raw');
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const writing = writer
    .write(data as Uint8Array<ArrayBuffer>)
    .then(() => writer.close());
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await writing;
  const out = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

describe('zip', () => {
  it('matches the IEEE CRC of the standard check string', () => {
    expect(crc32(text.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('round-trips STORE entries, including empty and non-ascii names', async () => {
    const files = [
      { name: 'manifest.json', data: text.encode('{"n":1}') },
      { name: 'empty.json', data: new Uint8Array() },
      { name: 'دکان.json', data: text.encode('دکان') },
      { name: 'bin.dat', data: new Uint8Array([0, 255, 10, 13]) },
    ];
    const bytes = zipStore(files, Date.UTC(2026, 0, 2, 3, 4, 5));
    const back = await unzip(bytes);
    expect(back.map((file) => file.name)).toEqual(
      files.map((file) => file.name),
    );
    for (let i = 0; i < files.length; i += 1) {
      expect(Array.from(back[i]?.data ?? [])).toEqual(
        Array.from(files[i]?.data ?? []),
      );
    }
  });

  it('round-trips an empty archive', async () => {
    expect(await unzip(zipStore([]))).toEqual([]);
  });

  it('streams the same archive from Blob parts without a full buffer', async () => {
    const now = Date.UTC(2026, 0, 2, 3, 4, 5);
    const files = [
      { name: 'manifest.json', data: text.encode('{"n":1}') },
      { name: 'empty.json', data: new Uint8Array() },
      { name: 'دکان.json', data: text.encode('دکان') },
    ];
    const writer = new ZipStoreWriter(now);
    for (const file of files) writer.add(file.name, file.data);
    const streamed = new Uint8Array(await writer.finish().arrayBuffer());
    expect(Array.from(streamed)).toEqual(Array.from(zipStore(files, now)));
    const byHelper = new Uint8Array(
      await zipStoreBlob(files, now).arrayBuffer(),
    );
    expect(Array.from(byHelper)).toEqual(Array.from(streamed));
    const back = await unzip(streamed);
    expect(back.map((file) => file.name)).toEqual(
      files.map((file) => file.name),
    );
    expect(writer.finish.bind(writer)).toThrow(ZipError);
  });

  it('inflates a deflate-raw entry', async () => {
    const raw = text.encode('hello hello hello hello');
    const bytes = writeZip([
      {
        name: 'a.txt',
        data: raw,
        method: 8,
        compressed: await deflateRaw(raw),
      },
    ]);
    const back = await unzip(bytes);
    expect(back).toHaveLength(1);
    expect(new TextDecoder().decode(back[0]?.data ?? new Uint8Array())).toBe(
      'hello hello hello hello',
    );
  });

  it('inflates an entry larger than the transform stream buffer', async () => {
    const raw = new Uint8Array(1024 * 1024);
    for (let i = 0; i < raw.length; i += 1) raw[i] = i % 251;
    const bytes = writeZip([
      {
        name: 'large.bin',
        data: raw,
        method: 8,
        compressed: await deflateRaw(raw),
      },
    ]);
    const back = await unzip(bytes);
    expect(back).toHaveLength(1);
    expect(back[0]?.data.length).toBe(raw.length);
    expect(back[0]?.data[500_000]).toBe(raw[500_000]);
  });

  it('refuses an entry whose declared size exceeds the inflation cap', async () => {
    const raw = text.encode('small');
    const bytes = writeZip([
      {
        name: 'small.txt',
        data: raw,
        method: 8,
        compressed: await deflateRaw(raw),
      },
    ]);
    const view = new DataView(bytes.buffer);
    let central = 0;
    while (view.getUint32(central, true) !== 0x02014b50) central += 1;
    view.setUint32(central + 24, MAX_ENTRY_BYTES + 1, true);
    await expect(unzip(bytes)).rejects.toBeInstanceOf(ZipError);
  });

  it('refuses an archive over the total decompressed cap', async () => {
    const bytes = zipStore([
      { name: 'a.json', data: text.encode('12345') },
      { name: 'b.json', data: text.encode('12345') },
    ]);
    await expect(unzip(bytes, { maxTotalBytes: 8 })).rejects.toBeInstanceOf(
      ZipError,
    );
  });

  it('skips excluded entries without reading them', async () => {
    const bytes = zipStore([
      { name: 'json/sales.json', data: text.encode('[]') },
      { name: 'csv/sales.csv', data: text.encode('a,b') },
    ]);
    const entries = await unzip(bytes, {
      include: (name) => name.endsWith('.json'),
    });
    expect(entries.map((entry) => entry.name)).toEqual(['json/sales.json']);
  });

  it('refuses a truncated archive and a bad CRC', async () => {
    await expect(unzip(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(
      ZipError,
    );
    const bytes = zipStore([{ name: 'a.txt', data: text.encode('abc') }]);
    const dataAt = 30 + text.encode('a.txt').length;
    bytes[dataAt] = (bytes[dataAt] ?? 0) ^ 0xff;
    await expect(unzip(bytes)).rejects.toBeInstanceOf(ZipError);
  });
});
