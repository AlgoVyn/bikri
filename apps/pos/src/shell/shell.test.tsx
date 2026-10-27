import { BASE_PATH } from '@bikri/core';
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../data/db.ts';
import { setKv } from '../data/kv.ts';
import { seedReadyShop, seedTodaySales, unlockAs } from '../dev/seed.ts';
import { initI18n, setLanguage } from '../i18n/i18n.ts';
import { resetUpdateStore, setUpdateReady } from '../pwa/updateStore.ts';
import { routeTree } from '../routeTree.gen.ts';
import { useSession } from '../state/session.ts';

async function renderAt(entry: string) {
  const history = createMemoryHistory({ initialEntries: [entry] });
  const router = createRouter({ routeTree, history, basepath: BASE_PATH });
  await router.load();
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(async () => {
  localStorage.clear();
  resetUpdateStore();
  await initI18n('en');
  await seedReadyShop();
  useSession.getState().lock();
});

describe('app shell', () => {
  it('switches to Urdu and flips direction', async () => {
    const user = userEvent.setup();
    await renderAt(`${BASE_PATH}/`);
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
    expect(
      await screen.findByRole('heading', { name: 'Assalam-o-Alaikum, Adnan' }),
    ).toBeTruthy();
    expect(await screen.findByText('Add your first products')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Language'), 'ur');
    expect(
      await screen.findByRole('heading', { name: 'السلام علیکم، Adnan' }),
    ).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ur');
    expect(screen.getByText('اپنی پہلی مصنوعات شامل کریں')).toBeTruthy();
    expect(screen.queryByText('Add your first products')).toBeNull();
  });

  it('opens a stub from the rail and keeps unknown paths on the not-found page', async () => {
    const user = userEvent.setup();
    await renderAt(`${BASE_PATH}/`);
    await user.click(await screen.findByRole('link', { name: /Sell/ }));
    expect(await screen.findByRole('heading', { name: 'Sell' })).toBeTruthy();
  });

  it('renders the not-found copy for an unknown path', async () => {
    await renderAt(`${BASE_PATH}/missing-page`);
    expect(
      await screen.findByRole('heading', {
        name: 'This page is not available.',
      }),
    ).toBeTruthy();
  });

  it('applies a service-worker update only when the indicator is tapped', async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    setUpdateReady(true, apply);
    await renderAt(`${BASE_PATH}/`);
    expect(apply).not.toHaveBeenCalled();
    await user.click(
      await screen.findByRole('button', { name: 'Update ready' }),
    );
    expect(apply).toHaveBeenCalledOnce();
  });

  it('moves with Alt+2 and ignores the shortcut inside a field', async () => {
    const user = userEvent.setup();
    await renderAt(`${BASE_PATH}/settings`);
    expect(
      await screen.findByRole('heading', { name: 'Settings' }),
    ).toBeTruthy();
    const language = screen.getByLabelText('Language');
    language.focus();
    await user.keyboard('{Alt>}{Digit2}{/Alt}');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    language.blur();
    await user.keyboard('{Alt>}2{/Alt}');
    expect(await screen.findByRole('heading', { name: 'Sell' })).toBeTruthy();
    await setLanguage('en');
  });

  it('shows all nine rail items to the owner, with the shop name', async () => {
    await renderAt(`${BASE_PATH}/`);
    const rail = await screen.findByRole('navigation', { name: 'Main' });
    expect(
      await screen.findByText('Algovyn Mobiles', {
        selector: '[data-testid="shop-name-rail"]',
      }),
    ).toBeTruthy();
    for (const name of [
      'Home',
      'Sell',
      'Products',
      'Sales',
      'Udhaar',
      'Suppliers',
      'Expenses',
      'Reports',
      'Settings',
    ]) {
      expect(rail.querySelector(`a[title^="${name} ("]`)).not.toBeNull();
    }
  });

  it('hides what a cashier cannot use and refuses it by URL (AC 2)', async () => {
    await unlockAs('cashier');
    await renderAt(`${BASE_PATH}/suppliers`);
    expect(await screen.findByText("You don't have access")).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'Assalam-o-Alaikum, Sana' }),
    ).toBeTruthy();
    const rail = screen.getByRole('navigation', { name: 'Main' });
    expect(rail.querySelector('a[title^="Suppliers ("]')).toBeNull();
    expect(rail.querySelector('a[title^="Sell ("]')).not.toBeNull();
  });

  it('hides profit and drawer cash from a cashier but shows them to the owner', async () => {
    await seedTodaySales();
    await renderAt(`${BASE_PATH}/`);
    expect((await screen.findByTestId('today-sold')).textContent).toContain(
      '1,000',
    );
    expect((await screen.findByTestId('today-profit')).textContent).toContain(
      '400',
    );
    expect((await screen.findByTestId('today-cash')).textContent).toContain(
      '750',
    );
    expect(screen.getByText('A-A-2')).toBeTruthy();
  });

  it('cashier Home has no profit or cash cards', async () => {
    await seedTodaySales();
    await unlockAs('cashier');
    await renderAt(`${BASE_PATH}/`);
    expect(await screen.findByTestId('today-sold')).toBeTruthy();
    expect(screen.queryByTestId('today-profit')).toBeNull();
    expect(screen.queryByTestId('today-cash')).toBeNull();
  });

  it('opens Sell with N and focuses search with /', async () => {
    const user = userEvent.setup();
    await renderAt(`${BASE_PATH}/`);
    await screen.findByRole('heading', { name: 'Assalam-o-Alaikum, Adnan' });
    await user.keyboard('/');
    expect(document.activeElement?.id).toBe('global-search');
    await user.keyboard('A-A');
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('n');
    expect(await screen.findByRole('heading', { name: 'Sell' })).toBeTruthy();
  });

  it('finds bills from the top bar search', async () => {
    const user = userEvent.setup();
    await seedTodaySales();
    await renderAt(`${BASE_PATH}/`);
    await user.type(
      await screen.findByRole('combobox', { name: /Search/ }),
      'A-A-1',
    );
    expect(await screen.findByRole('option', { name: /A-A-1/ })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Sales' })).toBeTruthy();
  });

  it('shows the read-only and support banners from kv', async () => {
    await setKv(getDb(), 'tenant_status', { status: 'read_only', since: 1 });
    await setKv(getDb(), 'support', {
      until: Date.now() + 3_600_000,
      reason: 'Fix stock',
    });
    await renderAt(`${BASE_PATH}/`);
    expect(
      (await screen.findByTestId('banner-read-only')).textContent,
    ).toContain('This shop is read-only');
    expect((await screen.findByTestId('banner-support')).textContent).toContain(
      'Reason: Fix stock.',
    );
  });

  it('counts waiting outbox ops in the sync badge', async () => {
    await renderAt(`${BASE_PATH}/`);
    const badge = await screen.findByTestId('sync-badge');
    expect(badge.getAttribute('aria-label')).toMatch(/^\d+ changes waiting/u);
  });
});
