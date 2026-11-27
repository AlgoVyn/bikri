import { lazy, Suspense, useEffect } from 'react';
import { composing, dialogOpen, ignoresHotkey } from '../lib/hotkeys.ts';
import { useGlobalSearch } from './searchStore.ts';

/**
 * The `/` hotkey stays in this tiny shell component; the search panel (search index,
 * date business logic and Radix dialog) loads only when the overlay is first opened.
 */
const GlobalSearchHost = lazy(() =>
  import('./GlobalSearch.tsx').then((module) => ({
    default: module.GlobalSearchHost,
  })),
);

export function GlobalSearchGate() {
  const open = useGlobalSearch((state) => state.open);
  const openSearch = useGlobalSearch((state) => state.openSearch);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        composing(event) ||
        dialogOpen() ||
        event.key !== '/' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        ignoresHotkey(event.target)
      )
        return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);

  if (!open) return null;
  return (
    <Suspense
      fallback={
        <div
          aria-hidden="true"
          className="bikri-overlay fixed inset-0 z-40 bg-scrim"
        />
      }
    >
      <GlobalSearchHost />
    </Suspense>
  );
}
