import { API_BASE, BASE_PATH } from '@bikri/core';
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
    VitePWA(pwaOptions),
  ],
  build: {
    outDir: `dist${BASE_PATH}`,
    emptyOutDir: true,
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
