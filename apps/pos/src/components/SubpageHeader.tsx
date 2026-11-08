import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ChevronLeftIcon } from './icons.tsx';

/** Parents a utility page can return to with the shared header. */
export type SubpageParent =
  | '/'
  | '/products'
  | '/products/$id'
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
  backParams,
  backLabel,
  onBack,
  icon,
  title,
  titleLevel = 'h1',
  subtitle,
  actions,
  stackActions = false,
  showBack = true,
}: {
  backTo: SubpageParent;
  /** Params when the parent is a dynamic detail route, e.g. `/products/$id`. */
  backParams?: { id: string };
  /** Accessible name of the back link (the destination, not just "Back"). */
  backLabel: string;
  /** Intercept the back link, e.g. to confirm unsaved changes before leaving. */
  onBack?: () => void;
  icon?: ReactNode;
  title: string;
  /** Use `h2` when the page's main title is already elsewhere (master–detail preview). */
  titleLevel?: 'h1' | 'h2';
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Keep actions on their own row below the title, even on wide viewports. */
  stackActions?: boolean;
  /** Hide the back affordance when the parent list is already on screen. */
  showBack?: boolean;
}) {
  const Heading = titleLevel;
  return (
    <header className="flex flex-wrap items-start gap-3">
      {showBack ? (
        <Link
          to={backTo}
          params={backParams}
          aria-label={backLabel}
          title={backLabel}
          onClick={(event) => {
            if (!onBack) return;
            event.preventDefault();
            onBack();
          }}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface text-text transition-colors duration-150 hover:bg-surface-2 active:bg-surface-2"
        >
          <ChevronLeftIcon className="size-5 rtl:rotate-180" />
        </Link>
      ) : null}
      {icon ? (
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary-subtle text-primary-subtle-ink"
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1 pt-1.5">
        <Heading
          className={`text-balance ${
            titleLevel === 'h1' ? 'text-h1' : 'text-h2'
          } font-semibold tracking-[-0.01em]`}
        >
          {title}
        </Heading>
        {subtitle ? (
          <p className="mt-1 max-w-2xl text-small text-text-muted">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div
          className={`flex w-full flex-wrap items-center gap-2 ${
            stackActions ? '' : 'sm:ms-auto sm:w-auto'
          }`}
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
