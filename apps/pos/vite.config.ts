import { API_BASE, BASE_PATH } from '@bikri/core';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaOptions } from './pwa.config.ts';

function rewriteFontBase(): Plugin {
  const rewrite = (code: string): string =>
    code.replaceAll('/__BIKRI_BASE__', BASE_PATH);
  return {
    name: 'bikri-font-base',
    enforce: 'post',
    transform(code) {
      if (!code.includes('/__BIKRI_BASE__')) {
        return null;
      }
      return rewrite(code);
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== 'asset' || typeof item.source !== 'string') {
          continue;
        }
        if (item.source.includes('/__BIKRI_BASE__')) {
          item.source = rewrite(item.source);
        }
      }
    },
  };
}

/**
 * Preload the active language catalog. `initI18n` awaits a dynamic import before the
 * first render, so without this the browser pays a serial round trip after the entry
 * chunk executes. The hash of each catalog is only known after bundling, so inject a
 * tiny language-aware modulepreload into index.html.
 */
function localePreload(): Plugin {
  return {
    name: 'bikri-locale-preload',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const locales: Record<string, string> = {};
      for (const [file, item] of Object.entries(bundle)) {
        if (item.type !== 'chunk') continue;
        const id = item.facadeModuleId ?? '';
        for (const locale of ['en', 'ur', 'roman-ur']) {
          if (id.endsWith(`/packages/i18n/${locale}.json`))
            locales[locale] = file;
        }
      }
      const html = bundle['index.html'];
      if (html?.type !== 'asset' || typeof html.source !== 'string') return;
      const placeholder = /<meta name="bikri-locales"[^>]*>/u;
      if (!placeholder.test(html.source)) return;
      // The pre-paint inline script (already covered by the CSP hash) reads this map
      // and adds the modulepreload itself. A separate preload script cost one serial
      // round trip before the active catalog could start downloading.
      html.source = html.source.replace(
        placeholder,
        `<meta name="bikri-locales" content='${JSON.stringify(locales)}' />`,
      );
    },
  };
}

export default defineConfig({
  base: `${BASE_PATH}/`,
  // Parse locale catalogs with JSON.parse instead of shipping a multi-megabyte JS
  // object literal; V8 parses JSON faster and the startup catalog is the largest one.
  json: { stringify: true },
  plugins: [
    rewriteFontBase(),
    localePreload(),
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: false,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      quoteStyle: 'single',
      semicolons: true,
      addExtensions: true,
    }),
    react(),
    tailwindcss(),
    VitePWA(pwaOptions),
  ],
  // Module workers keep their dynamic imports (sheet parsers) as separate lazy chunks
  // and can use the same ES chunk format as the main app instead of a classic IIFE.
  worker: { format: 'es' },
  build: {
    outDir: `dist${BASE_PATH}`,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Rolldown's default automatic splitting produced 200+ micro-chunks (many
        // under 1 KB), which cost a request/header/ES-module link per file. Group the
        // vendor families and let the small-chunk threshold merge the rest; route
        // code and the operator console stay separate (see chunkFileNames).
        codeSplitting: {
          minSize: 12_000,
          groups: [
            {
              name: 'vendor-react',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 40,
            },
            {
              name: 'vendor-router',
              test: /node_modules[\\/]@tanstack[\\/]/,
              priority: 30,
            },
            {
              name: 'vendor-dexie',
              test: /node_modules[\\/]dexie[\\/]/,
              priority: 30,
            },
            {
              name: 'vendor-i18n',
              test: /node_modules[\\/](i18next|react-i18next)[\\/]/,
              priority: 30,
            },
            {
              name: 'vendor-radix',
              test: /node_modules[\\/]@radix-ui[\\/]/,
              priority: 30,
            },
            {
              name: 'vendor',
              // Keep dynamically imported spreadsheet/QR libraries out of the initial
              // vendor chunk. They are only needed when a file is imported or a QR is
              // rendered, so the catch-all must not pull them into every cold load.
              test: /^(?!.*node_modules[\\/](read-excel-file|fflate|papaparse|qrcode-generator)[\\/]).*node_modules[\\/]/,
              priority: 10,
              minSize: 20_000,
            },
            {
              // All modules the shell statically needs, except the entry module.
              // main.tsx has a top-level `await initI18n()`; if it shared a chunk
              // with modules a lazy chunk imports, that lazy chunk would wait on an
              // entry chunk that is itself waiting for the lazy import (deadlock).
              debugName: 'app-shared',
              name: (moduleId) =>
                moduleId.includes('/src/main.tsx') ? null : 'app-shared',
              tags: ['$initial'],
              priority: 4,
              minSize: 0,
            },
            {
              // Lazy feature modules: one chunk per source area instead of one per
              // module. The operator console stays automatic so it can live under
              // assets/admin and remain excluded from the offline precache.
              debugName: 'app-area',
              name: (moduleId) => {
                // The operator console and the public request pages stay automatic
                // so chunkFileNames can move them under assets/admin|public.
                if (
                  /\/src\/(?:admin|routes\/admin)(?:\/|\.)/u.test(moduleId) ||
                  /\/src\/(?:public|routes\/request(?:-status)?(?:\.|\/))/u.test(
                    moduleId,
                  )
                )
                  return null;
                // Merge each lazy route wrapper into the feature chunk it renders.
                // Previously every file under src/routes/ matched "routes" and the
                // 18 wrappers collapsed into one 436 KB-gz first-route closure.
                const route = /\/src\/routes\/([^/]+)/u.exec(moduleId);
                if (route) {
                  const area: Record<string, string> = {
                    index: 'app-home',
                    sell: 'app-sell',
                    sales: 'app-sales',
                    suppliers: 'app-suppliers',
                    quotations: 'app-quotes',
                    'day-close': 'app-dayclose',
                    reports: 'app-reports',
                    expenses: 'app-expenses',
                    products: 'app-products',
                    stock: 'app-products',
                    labels: 'app-labels',
                    settings: 'app-settings',
                    setup: 'app-setup',
                    udhaar: 'app-udhaar',
                    $: 'app-shell',
                    __root: 'app-shell',
                    'dev.demo': 'app-shared',
                    'dev.ui': 'app-shared',
                  };
                  const name = area[route[1] ?? ''];
                  if (name !== undefined) return name;
                }
                const match = /\/src\/([a-z0-9]+)\//u.exec(moduleId);
                return match ? `app-${match[1]}` : null;
              },
              test: /\/src\//,
              priority: 3,
              minSize: 8_000,
            },
          ],
        },
        // Keep operator-console code in its own folder so the service worker can
        // exclude it from the till precache. Route chunks in `_id.lazy-*` share a
        // generic name with shop routes, so the module list is the reliable marker.
        // A chunk is moved only when *every* module belongs to that area: a shared
        // chunk with even one shop module must stay in the precached graph, or the
        // till's offline start would import a file the service worker skipped.
        // Shop code must reach these areas only through `import()`/`React.lazy`;
        // a static import would make a precached chunk depend on an online-only one
        // (D-299), and `tools/check-bundle-size.mjs` fails the build for it.
        chunkFileNames: (chunk) => {
          const moduleIds =
            chunk.moduleIds.length > 0
              ? chunk.moduleIds
              : [chunk.facadeModuleId ?? ''];
          const inArea = (pattern: RegExp) =>
            moduleIds.length > 0 && moduleIds.every((id) => pattern.test(id));
          if (
            inArea(
              /\/src\/(?:admin|routes\/admin)(?:\/|\.)|\/packages\/i18n\/admin\//u,
            )
          )
            return 'assets/admin/[name]-[hash].js';
          if (
            inArea(
              /\/src\/(?:public|routes\/request(?:-status)?(?:\.|\/))|\/packages\/i18n\/public\//u,
            )
          )
            return 'assets/public/[name]-[hash].js';
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Test/coverage/build output inside the app folder otherwise floods the watcher
    // while a dev server is open, and HMR can miss a source edit.
    watch: { ignored: ['**/coverage/**', '**/dist/**', '**/test-results/**'] },
    proxy: {
      [API_BASE]: {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
