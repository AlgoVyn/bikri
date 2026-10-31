import type { ReactNode } from 'react';

/**
 * One surface for a list screen (docs/08 §2): toolbar, optional context strip, then rows.
 * Screens must not stack a filter card, a summary card and a list card separately.
 */
export function ListSurface({
  toolbar,
  summary,
  children,
}: {
  toolbar?: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      {toolbar !== undefined ? (
        <div className="border-b border-border p-3">{toolbar}</div>
      ) : null}
      {summary !== undefined ? (
        <div className="border-b border-border px-3 py-2">{summary}</div>
      ) : null}
      {children}
    </section>
  );
}
