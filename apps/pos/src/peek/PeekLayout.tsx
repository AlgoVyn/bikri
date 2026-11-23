import type { ReactNode } from 'react';

export function PeekFigure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-card bg-primary-subtle p-3">
      <span className="block text-small text-primary-subtle-ink">{label}</span>
      <strong className="mt-0.5 block whitespace-nowrap text-title font-semibold text-primary-subtle-ink">
        {children}
      </strong>
    </div>
  );
}

export function PeekFacts({
  rows,
}: {
  rows: readonly { label: string; value: ReactNode }[];
}) {
  return (
    <div className="rounded-card border border-border">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-start justify-between gap-3 border-b border-border px-3 py-2 text-small last:border-b-0"
        >
          <span className="shrink-0 text-text-muted">{row.label}</span>
          <span className="min-w-0 text-end">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

export function PeekSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-card border border-border">
      <h3 className="border-b border-border bg-surface-2 px-3 py-2 text-title font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function PeekRow({
  label,
  value,
  strong = false,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2 text-small last:border-b-0">
      <span className="min-w-0">{label}</span>
      <span
        className={`shrink-0 text-end ${strong ? 'font-semibold' : 'font-medium'}`}
      >
        {value}
      </span>
    </div>
  );
}

export function PeekNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-card bg-primary-subtle px-3 py-2 text-small text-primary-subtle-ink">
      {children}
    </p>
  );
}

export function PeekEmpty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-small text-text-muted">{children}</p>;
}
