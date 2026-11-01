import { BASE_PATH } from '@bikri/core';
import { createRouter } from '@tanstack/react-router';
import { RouteError } from './components/RouteError.tsx';
import { routeTree } from './routeTree.gen.ts';

export const router = createRouter({
  routeTree,
  basepath: BASE_PATH,
  defaultErrorComponent: RouteError,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
