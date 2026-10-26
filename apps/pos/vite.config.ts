import { API_BASE, BASE_PATH } from '@bikri/core';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: `${BASE_PATH}/`,
  plugins: [
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
