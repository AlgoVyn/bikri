import { createHash } from 'node:crypto';
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
      const placeholder = /<meta name="bikri-locale-preload"[^>]*>/u;
      if (!placeholder.test(html.source)) return;
      // The strict script CSP allows external scripts only. Emit a hashed file and
      // reference it from the document; the map still points at the language chunks.
      const source = `try{var l=localStorage.getItem('bikri.language')||'en';var m=${JSON.stringify(locales)};var f=m[l];if(f){var k=document.createElement('link');k.rel='modulepreload';k.crossOrigin='';k.href='${BASE_PATH}/'+f;document.head.appendChild(k)}}catch(e){}`;
      const hash = createHash('sha256')
        .update(source)
        .digest('hex')
        .slice(0, 12);
      const fileName = `assets/locale-preload-${hash}.js`;
      this.emitFile({ type: 'asset', fileName, source });
      html.source = html.source.replace(
        placeholder,
        `<script src="${BASE_PATH}/${fileName}"></script>`,
      );
    },
  };
}

export default defineConfig({
  base: `${BASE_PATH}/`,
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
  build: {
    outDir: `dist${BASE_PATH}`,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Keep operator-console code in its own folder so the service worker can
        // exclude it from the till precache. Route chunks in `_id.lazy-*` share a
        // generic name with shop routes; module ids are the only reliable marker.
        chunkFileNames: (chunk) => {
          // Only dynamic route entry chunks that live in the operator console are moved
          // out of the PWA precache. Shared chunks (for example `app`) can contain both
          // admin and shop modules; moving those under assets/admin would make the shop
          // offline start depend on a chunk the service worker intentionally skipped.
          const facade = chunk.facadeModuleId ?? '';
          const admin =
            chunk.isDynamicEntry &&
            (facade.includes('/src/routes/admin') ||
              facade.includes('/src/admin/'));
          return admin
            ? 'assets/admin/[name]-[hash].js'
            : 'assets/[name]-[hash].js';
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      [API_BASE]: {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
