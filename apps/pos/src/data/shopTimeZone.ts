import { isTimeZone } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import type { Table } from 'dexie';

type ShopSource = { table(name: string): Table };

/**
 * The shop's time zone, with the documented default. Kept in its own module so the
 * shell/Banners do not pull the whole sales-history data layer into the initial bundle.
 * A typo from an import/restore must not make every Intl call throw (D-218).
 */
export async function shopTimeZone(src: ShopSource): Promise<string> {
  const shop = await (src.table('shop') as Table<MasterRow, string>).get(
    'shop',
  );
  const tz = String(shop?.timezone ?? '');
  return isTimeZone(tz) ? tz : 'Asia/Karachi';
}
