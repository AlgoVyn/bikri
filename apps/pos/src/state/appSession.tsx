import type { ReactNode } from 'react';
import { ShopTimeZoneProvider } from '../data/useShopTimeZone.ts';
import { CurrentStaffProvider } from './currentStaff.ts';
import { ReadOnlyProvider } from './readOnly.ts';

/**
 * The shell-wide session reads (staff, permissions, read-only, time zone) with one live
 * query each. Every screen reads the same context instead of opening its own subscription.
 */
export function AppSessionProvider({ children }: { children: ReactNode }) {
  return (
    <CurrentStaffProvider>
      <ReadOnlyProvider>
        <ShopTimeZoneProvider>{children}</ShopTimeZoneProvider>
      </ReadOnlyProvider>
    </CurrentStaffProvider>
  );
}
