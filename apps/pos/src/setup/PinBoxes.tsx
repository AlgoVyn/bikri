import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

/** 4 masked digit boxes with a numeric keypad on touch (screens/01 step 2). */
export function PinBoxes({
  label,
  value,
  onChange,
  error,
  idPrefix,
}: {
  label: string;
  value: string;
  onChange: (pin: string) => void;
  error?: string | null;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = [0, 1, 2, 3];
  const errorId = `${idPrefix}-error`;
  return (
    <fieldset>
      <legend className="mb-1 text-small text-text">{label}</legend>
      <div className="flex gap-2" dir="ltr">
        {digits.map((i) => (
          <input
            key={i}
            id={i === 0 ? idPrefix : undefined}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            aria-label={t('setup.pin_digit', { label, n: i + 1 })}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="h-12 w-12 rounded-control border border-border-strong bg-surface text-center font-mono text-h2"
            value={(value[i] ?? ' ').trim()}
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              const digit = e.target.value.replace(/\D/g, '').slice(-1);
              // Fixed 4 slots; an empty slot is a space so clearing one box never shifts the others.
              const slots = [0, 1, 2, 3].map((n) => value[n] ?? ' ');
              slots[i] = digit || ' ';
              onChange(slots.join('').trimEnd());
              if (digit && i < 3) refs.current[i + 1]?.focus();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && !(value[i] ?? ' ').trim() && i > 0)
                refs.current[i - 1]?.focus();
            }}
          />
        ))}
      </div>
      {error ? (
        <p id={errorId} className="mt-1 text-small text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
