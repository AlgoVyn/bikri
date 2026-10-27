import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(async () => {
  cleanup();
  // Let in-flight Dexie liveQuery reads settle before the next test closes the tenant DB.
  await new Promise((resolve) => setTimeout(resolve, 10));
});
