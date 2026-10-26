import { useSyncExternalStore } from 'react';
import { getUpdateSnapshot, subscribeUpdate } from './updateStore.ts';

export function useUpdateReady(): {
  updateReady: boolean;
  applyUpdate: () => void;
} {
  return useSyncExternalStore(
    subscribeUpdate,
    getUpdateSnapshot,
    getUpdateSnapshot,
  );
}
