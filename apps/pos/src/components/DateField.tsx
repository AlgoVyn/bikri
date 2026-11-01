import { useId } from 'react';

/** A labelled native date input with the app's control height and border. */
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
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={`flex flex-col gap-1 text-small ${className}`}
    >
      <span>{label}</span>
      <input
        id={id}
        type="date"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text tabular-nums [&::-webkit-calendar-picker-indicator]:opacity-60 disabled:bg-surface-2 disabled:text-text-muted"
      />
      {hint ? <span className="text-text-muted">{hint}</span> : null}
    </label>
  );
}
