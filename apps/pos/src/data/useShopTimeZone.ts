import { useLiveQuery } from 'dexie-react-hooks';
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
} from 'react';
import { getDb } from './db.ts';
import { shopTimeZone } from './shopTimeZone.ts';

/** The shop's time zone, with the documented default until the shop row loads. */
function useShopTimeZoneLive(): string {
  return useLiveQuery(() => shopTimeZone(getDb()), []) ?? 'Asia/Karachi';
}

const ShopTimeZoneContext = createContext<string | null>(null);

/** One live query for the shell; every `useShopTimeZone` site reads the context. */
export function ShopTimeZoneProvider({ children }: { children: ReactNode }) {
  return createElement(
    ShopTimeZoneContext.Provider,
    { value: useShopTimeZoneLive() },
    children,
  );
}

export function useShopTimeZone(): string {
  const shared = useContext(ShopTimeZoneContext);
  // biome-ignore lint/correctness/useHookAtTopLevel: the shell mounts the provider once; tests render without it
  return shared ?? useShopTimeZoneLive();
}
