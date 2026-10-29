import type { ReactNode } from 'react';

/**
 * The shared page header (reference: page icon + title + short subtitle, actions at the end).
 * The icon is decorative; the h1 is the accessible title.
 */
export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
  tone = 'bg-primary-subtle text-primary-subtle-ink',
  headingLevel = 'h1',
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  tone?: string;
  headingLevel?: 'h1' | 'h2';
}) {
  const Heading = headingLevel;
  return (
    <header className="flex flex-wrap items-start gap-3">
      {icon ? (
        <span
          aria-hidden="true"
          className={`flex size-10 shrink-0 items-center justify-center rounded-control ${tone}`}
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <Heading className="text-h1 font-semibold">{title}</Heading>
        {subtitle ? (
          <p className="mt-0.5 text-small text-text-muted">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
