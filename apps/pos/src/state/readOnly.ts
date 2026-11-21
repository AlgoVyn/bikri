import { useLiveQuery } from 'dexie-react-hooks';
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
} from 'react';
import { getDb } from '../data/db.ts';
import { isReadOnly } from '../sync/status.ts';

/** True when the till may look but not write: read-only shop or support device (13 §7.2/§7.5). */
function useReadOnlyLive(): boolean {
  return (
    useLiveQuery(async () => {
      const db = getDb();
      const kind = await db.kv.get('device_kind');
      return kind?.value === 'support' || (await isReadOnly(db));
    }, []) ?? false
  );
}

const ReadOnlyContext = createContext<boolean | null>(null);

/** One live query for the whole shell; every `useReadOnly` site reads the context. */
export function ReadOnlyProvider({ children }: { children: ReactNode }) {
  return createElement(
    ReadOnlyContext.Provider,
    { value: useReadOnlyLive() },
    children,
  );
}

export function useReadOnly(): boolean {
  const shared = useContext(ReadOnlyContext);
  // Tests and the pre-shell setup pages render without the provider.
  // biome-ignore lint/correctness/useHookAtTopLevel: the shell mounts the provider once; tests render without it
  return shared ?? useReadOnlyLive();
}
