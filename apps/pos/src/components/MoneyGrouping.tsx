import type { NumberGrouping } from '@bikri/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, type ReactNode, useContext } from 'react';
import { getDb } from '../data/db.ts';
import { setShopGrouping } from '../lib/money.ts';

const MoneyGroupingContext = createContext<NumberGrouping>('intl');

/**
 * Keeps every amount in the app on the shop's `number_grouping` setting, the same setting
 * the receipt and exports use. Outside the shell (admin/setup) the default stays 'intl'.
 */
export function MoneyGroupingProvider({ children }: { children: ReactNode }) {
  const grouping =
    useLiveQuery(
      async () => {
        const shop = await getDb().shop.get('shop');
        return shop?.number_grouping === 'lakh' ? 'lakh' : 'intl';
      },
      [],
      'intl',
    ) ?? 'intl';
  // Formatting helpers used in event handlers/toasts are not React consumers; keep the
  // module cache in step before the children render.
  setShopGrouping(grouping);
  return (
    <MoneyGroupingContext.Provider value={grouping}>
      {children}
    </MoneyGroupingContext.Provider>
  );
}

export function useMoneyGrouping(): NumberGrouping {
  return useContext(MoneyGroupingContext);
}
