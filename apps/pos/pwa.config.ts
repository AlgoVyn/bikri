import { BASE_PATH } from '@bikri/core';
import type { VitePWAOptions } from 'vite-plugin-pwa';

const scope = `${BASE_PATH}/`;

/**
 * PWA options for vite-plugin-pwa. Served under /bikri/ so the worker cannot
 * control the rest of algovyn.com. No runtime caching of the API.
 */
export const pwaOptions = {
  registerType: 'prompt',
  strategies: 'generateSW',
  filename: 'sw.js',
  manifestFilename: 'manifest.webmanifest',
  injectRegister: 'auto',
  base: scope,
  scope,
  /* Icons and fonts are precached by globPatterns. Listing them again as
     additional manifest entries makes workbox-build reject the duplicates. */
  includeManifestIcons: false,
  manifest: {
    id: scope,
    name: 'Bikri POS',
    short_name: 'Bikri',
    display: 'standalone',
    start_url: scope,
    scope,
    theme_color: '#006BB3',
    background_color: '#F1F5F9',
    orientation: 'any',
    /* The ledger-and-tick mark (D-216); masters and generator in scripts/. */
    icons: [
      {
        src: `${scope}icons/app-icon-192.png`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${scope}icons/app-icon-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${scope}icons/maskable-192.png`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: `${scope}icons/maskable-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  },
  workbox: {
    cacheId: 'bikri',
    // A prompt-mode update activates the new worker, but without `clients.claim`
    // the open page keeps the old controller and `controllerchange` never fires,
    // so the Update Ready button appears to do nothing. Claiming the clients makes
    // the reload happen immediately after activation.
    clientsClaim: true,
    navigateFallback: `${scope}index.html`,
    navigateFallbackDenylist: [/^\/bikri\/api\//, /^\/bikri\/admin/],
    /* Glob URLs are relative to dist/bikri. Prefix them so they match the scope
       and navigateFallback. The manifest file is added by the plugin itself. */
    modifyURLPrefix: { '': scope },
    globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
    // The operator console is always online and must not be precached (01 §6).
    globIgnores: [
      '**/admin/**',
      '**/admin.lazy-*.js',
      '**/backups.lazy-*.js',
      '**/useAdminQuery-*.js',
    ],
  },
  devOptions: {
    enabled: false,
  },
} satisfies Partial<VitePWAOptions>;
