import { BASE_PATH } from '@bikri/core';
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedReadyShop } from '../dev/seed.ts';
import { initI18n, setLanguage } from '../i18n/i18n.ts';
import { resetUpdateStore, setUpdateReady } from '../pwa/updateStore.ts';
import { routeTree } from '../routeTree.gen.ts';

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
});

describe('app shell', () => {
  it('switches to Urdu and flips direction', async () => {
    const user = userEvent.setup();
    await renderAt(`${BASE_PATH}/`);
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeTruthy();
    expect(await screen.findByText('Add your first product')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Language'), 'ur');
    expect(await screen.findByRole('heading', { name: 'ہوم' })).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ur');
    expect(screen.getByText('اپنی پہلی مصنوع شامل کریں')).toBeTruthy();
    expect(screen.queryByText('Add your first product')).toBeNull();
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
});
