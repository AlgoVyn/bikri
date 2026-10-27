import type { BikriDb } from '@bikri/db';

/** Local key/value settings (02 §3.1). Safe inside or outside a write transaction. */
export async function getKv<T>(
  db: BikriDb,
  key: string,
  fallback: T,
): Promise<T> {
  const row = await db.kv.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setKv(
  db: BikriDb,
  key: string,
  value: unknown,
): Promise<void> {
  await db.kv.put({ key, value });
}
