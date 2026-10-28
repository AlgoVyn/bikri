import type { ReactNode } from 'react';
import { buttonPrimary } from './classes.ts';

export function EmptyState({
  icon,
  heading,
  message,
  actionLabel,
  onAction,
}: {
  icon?: ReactNode;
  heading?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border-strong px-4 py-14 text-center">
      {icon !== undefined ? (
        <div className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-text-muted">
          {icon}
        </div>
      ) : null}
      {heading !== undefined ? <h1 className="sr-only">{heading}</h1> : null}
      <p className="max-w-sm text-text-muted">{message}</p>
      {actionLabel !== undefined && onAction !== undefined ? (
        <button type="button" className={buttonPrimary} onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
