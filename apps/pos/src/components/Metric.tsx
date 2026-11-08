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
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  size?: 'md' | 'lg';
  testId?: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`} data-testid={testId}>
      <p className="text-small text-text-muted">{label}</p>
      <p
        className={`${
          size === 'lg' ? 'text-total' : 'text-title'
        } font-semibold`}
      >
        {value}
      </p>
      {hint}
    </div>
  );
}
