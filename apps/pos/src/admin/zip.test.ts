import {
  CompressionStream as NodeCompressionStream,
  DecompressionStream as NodeDecompressionStream,
} from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { crc32, unzip, writeZip, ZipError, zipStore } from './zip.ts';

if (typeof globalThis.CompressionStream === 'undefined') {
  Object.assign(globalThis, { CompressionStream: NodeCompressionStream });
}
if (typeof globalThis.DecompressionStream === 'undefined') {
  Object.assign(globalThis, { DecompressionStream: NodeDecompressionStream });
}

const text = new TextEncoder();

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  await writer.write(data as Uint8Array<ArrayBuffer>);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
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
