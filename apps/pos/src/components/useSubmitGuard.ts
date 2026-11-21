import { useRef } from 'react';

/**
 * Synchronous double-submit guard. React state only disables a button after the next
 * render, so two clicks (or Enter + click) in the same tick both pass a `pending`
 * check. `lock()` is set before the first `await`; `unlock()` in `finally`.
 */
export function useSubmitGuard(): {
  lock: () => boolean;
  unlock: () => void;
} {
  const locked = useRef(false);
  return {
    lock: () => {
      if (locked.current) return false;
      locked.current = true;
      return true;
    },
    unlock: () => {
      locked.current = false;
    },
  };
}
