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

export default defineConfig({
  base: `${BASE_PATH}/`,
  plugins: [
    rewriteFontBase(),
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
          const ids = chunk.moduleIds ?? [];
          const admin = ids.some(
            (id) =>
              id.includes('/src/admin/') || id.includes('/src/routes/admin/'),
          );
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
