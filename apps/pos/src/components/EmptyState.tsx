import type { ReactNode } from 'react';
import { buttonPrimary } from './classes.ts';

export function EmptyState({
  icon,
  heading,
  message,
  actionLabel,
  onAction,
  variant = 'card',
  showHeading = false,
}: {
  icon?: ReactNode;
  heading?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  /** `plain` when the empty state already sits inside a list surface. */
  variant?: 'card' | 'plain';
  /** Show the heading visually (404). Other callers keep it as a landmark only. */
  showHeading?: boolean;
}) {
  return (
    <div
      className={
        variant === 'card'
          ? 'flex flex-col items-center gap-3 rounded-card border border-border bg-surface px-6 py-12 text-center shadow-card'
          : 'flex flex-col items-center gap-3 px-6 py-12 text-center'
      }
    >
      {icon !== undefined ? (
        <div className="flex size-12 items-center justify-center rounded-full bg-primary-subtle text-primary-subtle-ink">
          {icon}
        </div>
      ) : null}
      {heading !== undefined ? (
        <h1
          className={
            showHeading ? 'text-title font-semibold text-text' : 'sr-only'
          }
        >
          {heading}
        </h1>
      ) : null}
      <p className="max-w-sm text-body font-medium text-text">{message}</p>
      {actionLabel !== undefined && onAction !== undefined ? (
        <button type="button" className={buttonPrimary} onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
