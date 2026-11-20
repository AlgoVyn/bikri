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
  titleSize,
  hideTitleOnPhone = false,
  subtitleOnPhone = false,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tone?: string;
  headingLevel?: 'h1' | 'h2';
  /** Keep the semantic level while matching a different visual scale. */
  titleSize?: 'h1' | 'h2' | 'title';
  /** Shop list pages already show this title in the phone top bar. */
  hideTitleOnPhone?: boolean;
  /** Keep the subtitle below the phone top bar even when the title is hidden. */
  subtitleOnPhone?: boolean;
}) {
  const Heading = headingLevel;
  const size = titleSize ?? (headingLevel === 'h1' ? 'h1' : 'h2');
  const titleClass =
    size === 'h1'
      ? `text-h1${hideTitleOnPhone ? ' max-lg:sr-only' : ''}`
      : size === 'title'
        ? 'text-title'
        : 'text-h2';
  return (
    <header className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start">
      <div className="flex min-w-0 items-start gap-3 md:flex-1">
        {icon ? (
          <span
            aria-hidden="true"
            className={`${hideTitleOnPhone ? 'max-lg:hidden ' : ''}flex size-10 shrink-0 items-center justify-center rounded-control ${tone}`}
          >
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <Heading
            className={`text-balance ${titleClass} font-semibold tracking-[-0.01em]`}
          >
            {title}
          </Heading>
          {subtitle ? (
            <p
              className={`${hideTitleOnPhone && !subtitleOnPhone ? 'max-lg:hidden ' : ''}mt-1 max-w-2xl text-small text-text-muted`}
            >
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2 md:ms-auto md:w-auto md:justify-end">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
