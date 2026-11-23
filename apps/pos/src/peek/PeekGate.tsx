import { useSearch } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useRef } from 'react';
import { restorePeekFocus } from './focus.ts';
import { parsePeekTarget } from './peek.ts';

const LazyPeekHost = lazy(() =>
  import('./PeekHost.tsx').then((module) => ({ default: module.PeekHost })),
);

/**
 * Keeps the peek summaries (and their office strings) out of the initial bundle.
 * Mounts only when the current route has a valid `?peek=` target.
 */
export function PeekGate() {
  const search = useSearch({ strict: false }) as { peek?: unknown };
  const target = parsePeekTarget(search.peek);
  const open = target !== null;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    restorePeekFocus();
  }, [open]);
  if (target === null) return null;
  return (
    <Suspense fallback={null}>
      <LazyPeekHost />
    </Suspense>
  );
}
