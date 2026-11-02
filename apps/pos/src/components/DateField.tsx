import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBusinessDate } from '../lib/date.ts';
import { CalendarIcon } from './icons.tsx';

/**
 * A labelled date control with the app's own chrome. The native date input stays underneath
 * (so the platform picker and keyboard input still work) but is transparent; the visible
 * value uses the shared business-date format instead of the browser's `dd/mm/yyyy`.
 */
export function DateField({
  label,
  value,
  min,
  max,
  onChange,
  hint,
  disabled = false,
  className = '',
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { i18n } = useTranslation();
  const id = useId();
  const display = value ? formatBusinessDate(value, i18n.language) : '—';
  return (
    <label
      htmlFor={id}
      className={`flex flex-col gap-1 text-small ${className}`}
    >
      <span>{label}</span>
      <span
        className={`relative flex h-11 w-full items-center gap-2 rounded-control border border-border-strong px-3 transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15 ${
          disabled ? 'bg-surface-2 text-text-muted' : 'bg-surface text-text'
        }`}
      >
        <span
          className={`min-w-0 flex-1 truncate tabular-nums ${
            value ? '' : 'text-text-muted'
          }`}
        >
          {display}
        </span>
        <CalendarIcon className="size-4 shrink-0 text-text-muted" />
        <input
          id={id}
          type="date"
          aria-label={label}
          value={value}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
      </span>
      {hint ? <span className="text-text-muted">{hint}</span> : null}
    </label>
  );
}
