import type { ReactNode } from 'react';

/**
 * A secondary task page: the work on the start side, a short explanatory card
 * on the end side. It fills the desktop width without inventing a new surface.
 */
export function TaskLayout({
  children,
  aside,
}: {
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
      {aside ? <aside className="flex flex-col gap-3">{aside}</aside> : null}
    </div>
  );
}

/** The short “before you start / how this works” card beside a task. */
export function TaskAside({
  title,
  items,
}: {
  title: string;
  items: readonly string[];
}) {
  return (
    <section className="rounded-card border border-border bg-surface p-4 shadow-card">
      <h2 className="text-title font-semibold">{title}</h2>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 ps-4 text-small text-text-muted">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
