import { BASE_PATH } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { pwaOptions } from '../pwa.config.ts';

describe('pwa options', () => {
  it('scopes the worker to /bikri/ and does not cache the API', () => {
    expect(pwaOptions.base).toBe(`${BASE_PATH}/`);
    expect(pwaOptions.scope).toBe('/bikri/');
    expect(pwaOptions.filename).toBe('sw.js');
    expect(pwaOptions.registerType).toBe('prompt');
    expect(pwaOptions.strategies).toBe('generateSW');
    expect(pwaOptions.manifestFilename).toBe('manifest.webmanifest');
    expect(pwaOptions.workbox.cacheId).toBe('bikri');
    expect(pwaOptions.workbox.navigateFallback).toBe('/bikri/index.html');
    expect(pwaOptions.workbox.modifyURLPrefix).toEqual({ '': '/bikri/' });
    expect(pwaOptions.includeManifestIcons).toBe(false);
    expect('runtimeCaching' in pwaOptions.workbox).toBe(false);
    expect(
      pwaOptions.workbox.navigateFallbackDenylist?.map(
        (pattern) => pattern.source,
      ),
    ).toEqual([/^\/bikri\/api\//.source, /^\/bikri\/admin/.source]);
    expect(
      pwaOptions.workbox.navigateFallbackDenylist?.[0]?.test(
        '/bikri/api/health',
      ),
    ).toBe(true);
    expect(
      pwaOptions.workbox.navigateFallbackDenylist?.[1]?.test('/bikri/admin'),
    ).toBe(true);
    expect(
      pwaOptions.workbox.navigateFallbackDenylist?.[0]?.test('/bikri/sell'),
    ).toBe(false);
  });

  it('matches the manifest in the architecture doc', () => {
    expect(pwaOptions.manifest).toMatchObject({
      id: '/bikri/',
      name: 'Bikri POS',
      short_name: 'Bikri',
      display: 'standalone',
      start_url: '/bikri/',
      scope: '/bikri/',
      theme_color: '#006BB3',
      background_color: '#F8FAFC',
      orientation: 'any',
    });
    const icons = pwaOptions.manifest?.icons ?? [];
    expect(
      icons.map((icon) => `${icon.sizes ?? ''} ${icon.purpose ?? ''}`),
    ).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
    for (const icon of icons) {
      expect(icon.src.startsWith('/bikri/icons/')).toBe(true);
    }
  });
});
