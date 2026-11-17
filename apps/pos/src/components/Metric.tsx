import type { ReactNode } from 'react';

/**
 * One summary figure, shared by list summaries and report dashboards. `lg` is reserved for
 * the one number that answers the screen's main question; everything else is `md`.
 */
export function Metric({
  label,
  value,
  hint,
  size = 'md',
  testId,
  className = '',
  valueClassName = '',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  size?: 'md' | 'lg';
  testId?: string;
  className?: string;
  /** Extra classes for the figure, e.g. a smaller phone size for long amounts. */
  valueClassName?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`} data-testid={testId}>
      <p className="text-small text-text-muted">{label}</p>
      <p
        className={`${
          size === 'lg' ? 'text-total' : 'text-title'
        } font-semibold ${valueClassName}`}
      >
        {value}
      </p>
      {hint}
    </div>
  );
}
