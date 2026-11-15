import type { Table } from 'dexie';

/** Above this many keys, one full scan beats one index range per key (D-119). */
export const SCAN_ABOVE = 200;

type AnyOfTable<T> = {
  toArray(): Promise<T[]>;
  where(index: string): {
    anyOf(keys: readonly string[]): { toArray(): Promise<T[]> };
  };
};

/**
 * Rows whose `keyOf` is in `ids`.
 *
 * Dexie compiles `anyOf` to one index range per key, so a few hundred keys are
 * slower than a single table scan and thousands are dramatically slower. This is
 * the same "chunk, or scan once" rule used by the catalogue and report bundles;
 * keep the three implementations in step if the threshold changes.
 */
export async function rowsAnyOf<T>(
  table: AnyOfTable<T>,
  index: string,
  ids: readonly string[],
  keyOf: (row: T) => string,
  scanAbove = SCAN_ABOVE,
): Promise<T[]> {
  const list = [...new Set(ids.filter((id) => id !== ''))];
  if (list.length === 0) return [];
  if (list.length > scanAbove) {
    const wanted = new Set(list);
    return (await table.toArray()).filter((row) => wanted.has(keyOf(row)));
  }
  const out: T[] = [];
  for (let at = 0; at < list.length; at += 100) {
    const chunk = list.slice(at, at + 100);
    if (chunk.length > 0)
      out.push(...(await table.where(index).anyOf(chunk).toArray()));
  }
  return out;
}

/** The same helper for a Dexie `Table`, which has a precise key type. */
export function rowsAnyOfTable<T>(
  table: Table<T, string>,
  index: string,
  ids: readonly string[],
  keyOf: (row: T) => string,
  scanAbove = SCAN_ABOVE,
): Promise<T[]> {
  return rowsAnyOf(table, index, ids, keyOf, scanAbove);
}
