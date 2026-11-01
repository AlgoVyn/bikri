import { useLiveQuery } from 'dexie-react-hooks';
import { getDb } from './db.ts';
import { shopTimeZone } from './salesHistory.ts';

/** The shop's time zone, with the documented default until the shop row loads. */
export function useShopTimeZone(): string {
  return useLiveQuery(() => shopTimeZone(getDb()), []) ?? 'Asia/Karachi';
}
