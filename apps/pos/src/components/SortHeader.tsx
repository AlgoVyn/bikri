import { useTranslation } from 'react-i18next';
import type { SortDirection } from '../lib/sort.ts';
import { ChevronRightIcon } from './icons.tsx';

const directionLabel = (direction: SortDirection): string =>
  direction === 'asc' ? 'common.sort_ascending' : 'common.sort_descending';

/** A list column header that toggles ascending/descending when clicked. */
export function SortHeader({
  label,
  active,
  direction,
  onClick,
  secondLine,
  className = '',
  testId,
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
  secondLine?: string;
  className?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={
        active ? `${label}, ${t(directionLabel(direction))}` : undefined
      }
      data-sort-direction={active ? direction : undefined}
      data-testid={testId}
      className={`flex min-h-8 min-w-0 items-center gap-1 text-start leading-tight hover:text-text ${className}`}
    >
      <span className="min-w-0">{label}</span>
      {secondLine ? (
        <span className="block shrink-0 text-caption">{secondLine}</span>
      ) : null}
      {active ? (
        <ChevronRightIcon
          className={`size-3 shrink-0 ${
            direction === 'asc' ? '-rotate-90' : 'rotate-90'
          }`}
        />
      ) : null}
    </button>
  );
}

/** The phone/toolbar control for the current sort direction. */
export function SortDirectionButton({
  direction,
  onToggle,
  testId,
  className = '',
}: {
  direction: SortDirection;
  onToggle: () => void;
  testId?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t(directionLabel(direction));
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      data-testid={testId}
      data-direction={direction}
      className={`flex size-11 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface text-text hover:bg-surface-2 ${className}`}
    >
      <ChevronRightIcon
        className={`size-4 ${direction === 'asc' ? '-rotate-90' : 'rotate-90'}`}
      />
    </button>
  );
}
