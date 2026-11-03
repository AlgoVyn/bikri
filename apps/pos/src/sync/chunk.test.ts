import { describe, expect, it } from 'vitest';
import { chunkOpsByTx, jsonBytes, nextTxBatch } from './chunk.ts';

type Op = { tx_id: string; id: string; text?: string };

const op = (tx: string, id: string, text = ''): Op => ({ tx_id: tx, id, text });

describe('sync batching', () => {
  it('returns no chunks for an empty file', () => {
    expect(chunkOpsByTx([])).toEqual([]);
  });

  it('cuts recovery files only at transaction boundaries', () => {
    const ops = [
      ...Array.from({ length: 3 }, (_, i) => op('a', `a${i}`)),
      ...Array.from({ length: 4 }, (_, i) => op('b', `b${i}`)),
      ...Array.from({ length: 2 }, (_, i) => op('c', `c${i}`)),
    ];
    const chunks = chunkOpsByTx(ops, 5);
    expect(chunks.map((chunk) => chunk.length)).toEqual([3, 4, 2]);
    expect(chunks.flat()).toEqual(ops);
  });

  it('refuses a single transaction above the server op limit', () => {
    const ops = Array.from({ length: 4 }, (_, i) => op('a', `a${i}`));
    expect(() => chunkOpsByTx(ops, 3)).toThrow(/at most 3/);
  });

  it('measures bytes as UTF-8, not UTF-16 code units', () => {
    const value = { name: 'سام سنگ گلیکسی اے 15' };
    expect(jsonBytes(value)).toBeGreaterThan(JSON.stringify(value).length);
  });

  it('nextTxBatch keeps a transaction whole even when it crosses the byte target', () => {
    const ops = [op('a', 'a0', 'x'.repeat(100)), op('a', 'a1'), op('b', 'b0')];
    const batch = nextTxBatch(ops, (entry) => jsonBytes(entry), 200, 120);
    expect(batch.map((entry) => entry.id)).toEqual(['a0', 'a1']);
  });
});
