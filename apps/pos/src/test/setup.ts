import 'fake-indexeddb/auto';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Dexie live queries can take a moment beside the other package suites.
configure({ asyncUtilTimeout: 5_000 });

afterEach(async () => {
  cleanup();
  // Let in-flight Dexie liveQuery reads settle before the next test closes the tenant DB.
  await new Promise((resolve) => setTimeout(resolve, 10));
});
