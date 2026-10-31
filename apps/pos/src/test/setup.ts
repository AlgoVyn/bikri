import 'fake-indexeddb/auto';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// jsdom does not implement matchMedia; Mantine's color-scheme provider needs it.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: /min-width:\s*(\d+)px/u.test(query)
          ? window.innerWidth >=
            Number(/min-width:\s*(\d+)px/u.exec(query)?.[1] ?? 0)
          : false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

if (typeof window.scrollTo !== 'function') {
  window.scrollTo = (() => undefined) as typeof window.scrollTo;
}

// Dexie live queries can take a moment beside the other package suites.
configure({ asyncUtilTimeout: 5_000 });

afterEach(async () => {
  cleanup();
  // Let in-flight Dexie liveQuery reads settle before the next test closes the tenant DB.
  await new Promise((resolve) => setTimeout(resolve, 10));
});
