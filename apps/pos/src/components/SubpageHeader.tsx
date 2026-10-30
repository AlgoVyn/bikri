import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/** Parents a utility page can return to with the shared header. */
export type SubpageParent =
  | '/'
  | '/products'
  | '/settings'
  | '/suppliers'
  | '/udhaar';

/**
 * The shared subpage header: circular back affordance, decorative icon tile, title and
 * optional end actions. Settings, product utilities and Udhaar all use this frame so the
 * same level of the app never has two different headers.
 */
export function SubpageHeader({
  backTo,
  backLabel,
  icon,
  title,
  subtitle,
  actions,
}: {
  backTo: SubpageParent;
  /** Accessible name of the back link (the destination, not just "Back"). */
  backLabel: string;
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start gap-3">
      <Link
        to={backTo}
        aria-label={backLabel}
        title={backLabel}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface text-text hover:bg-surface-2 active:bg-surface-2"
      >
        <span
          aria-hidden="true"
          className="text-title leading-none rtl:rotate-180"
        >
          ‹
        </span>
      </Link>
      {icon ? (
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-2 text-text-muted"
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1 pt-1.5">
        <h1 className="text-h1 font-semibold">{title}</h1>
        {subtitle ? (
          <p className="mt-0.5 text-small text-text-muted">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:ms-auto sm:w-auto">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
