import { useLiveQuery } from 'dexie-react-hooks';
import { getDb } from '../data/db.ts';
import { isReadOnly } from '../sync/status.ts';

/** True when the till may look but not write: read-only shop or support device (13 §7.2/§7.5). */
export function useReadOnly(): boolean {
  return (
    useLiveQuery(async () => {
      const db = getDb();
      const kind = await db.kv.get('device_kind');
      return kind?.value === 'support' || (await isReadOnly(db));
    }, []) ?? false
  );
}
