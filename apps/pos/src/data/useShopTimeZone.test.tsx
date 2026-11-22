import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from './db.ts';
import { setActiveTenantId } from './tenant.ts';
import {
  ShopTimeZoneProvider,
  useShopTimeZone,
  useShopTimeZoneReady,
} from './useShopTimeZone.ts';

function Probe() {
  return (
    <span>{`${useShopTimeZone()}:${String(useShopTimeZoneReady())}`}</span>
  );
}

afterEach(() => {
  closeDb();
  setActiveTenantId(null);
});

describe('shop time zone context', () => {
  it('falls back without a provider and reports ready for tests', () => {
    render(<Probe />);
    expect(screen.getByText('Asia/Karachi:true')).toBeTruthy();
  });

  it('reports the shop value after the live query resolves', async () => {
    setActiveTenantId('tz-context-test');
    await getDb().shop.put({
      id: 'shop',
      name: 'TZ',
      timezone: 'America/New_York',
      created_at: 1,
      updated_at: 1,
      rev: 1,
    });
    render(
      <ShopTimeZoneProvider>
        <Probe />
      </ShopTimeZoneProvider>,
    );
    expect(await screen.findByText('America/New_York:true')).toBeTruthy();
  });
});
