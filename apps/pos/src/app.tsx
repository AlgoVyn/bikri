import { BASE_PATH } from '@bikri/core';
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen.ts';

export const router = createRouter({
  routeTree,
  basepath: BASE_PATH,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
