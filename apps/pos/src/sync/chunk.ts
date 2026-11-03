/** Push/import batching shared by the sync engine and the recovery-import screens. */

export const MAX_BATCH_OPS = 200;
export const MAX_BATCH_BYTES = 512 * 1024;

/** Request wrapper overhead (device id, schema version, JSON punctuation). */
const BODY_OVERHEAD_BYTES = 512;

/** Byte size of a JSON value as UTF-8, not JavaScript's UTF-16 string length. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * The next push batch: whole transactions only. A single oversized transaction is still
 * sent alone (the caller cannot split it); the server answers 413 and the operator has to
 * fix the data. Normal writes are capped at 200 ops / 512 KB by construction.
 */
export function nextTxBatch<T extends { tx_id: string }>(
  pending: readonly T[],
  measure: (op: T) => number,
  maxOps = MAX_BATCH_OPS,
  maxBytes = MAX_BATCH_BYTES,
): T[] {
  const batch: T[] = [];
  let bytes = 0;
  let i = 0;
  while (i < pending.length) {
    const tx = pending[i]?.tx_id;
    let j = i;
    let txBytes = 0;
    while (j < pending.length && pending[j]?.tx_id === tx) {
      txBytes += measure(pending[j] as T);
      j += 1;
    }
    const count = j - i;
    if (
      batch.length > 0 &&
      (batch.length + count > maxOps ||
        bytes + txBytes + BODY_OVERHEAD_BYTES > maxBytes)
    )
      break;
    batch.push(...pending.slice(i, j));
    bytes += txBytes;
    i = j;
    if (batch.length >= maxOps) break;
  }
  return batch;
}

/**
 * Cut a recovery file into request-sized chunks without ever splitting one transaction.
 * A single transaction over the server's 200-op limit cannot be imported and is reported
 * rather than silently half-applied.
 */
export function chunkOpsByTx<T extends { tx_id: string }>(
  ops: readonly T[],
  maxOps = MAX_BATCH_OPS,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let i = 0;
  while (i < ops.length) {
    const tx = ops[i]?.tx_id;
    let j = i;
    while (j < ops.length && ops[j]?.tx_id === tx) j += 1;
    const count = j - i;
    if (count > maxOps)
      throw new Error(
        `transaction ${String(tx)} has ${count} ops; the server accepts at most ${maxOps}`,
      );
    if (current.length > 0 && current.length + count > maxOps) {
      chunks.push(current);
      current = [];
    }
    current.push(...ops.slice(i, j));
    i = j;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
