/**
 * Shared search control chrome. The wrapper owns the border and the focus ring, so the
 * inner input must never draw the global outline itself (`.bikri-focus-wrapper`).
 */
export const searchWrapperClass =
  'flex h-11 min-w-0 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20';

export const searchInputClass =
  'bikri-focus-wrapper h-full min-w-0 flex-1 bg-transparent text-body text-text outline-none';
