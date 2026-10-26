import { normaliseNumericText, parseMoneyToPaisa } from '@bikri/core';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

const TRUE_MINUS = '\u2212';

function formatEditable(paisa: number): string {
  const negative = paisa < 0;
  const absolute = Math.abs(paisa);
  const whole = Math.trunc(absolute / 100);
  const fraction = absolute % 100;
  const body =
    fraction === 0
      ? String(whole)
      : `${whole}.${String(fraction).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

export function filterMoneyDraft(raw: string, allowNegative: boolean): string {
  let text = normaliseNumericText(raw).toLowerCase();
  text = text
    .replaceAll(TRUE_MINUS, '-')
    .replaceAll(',', '')
    .replaceAll(' ', '');
  text = text.replaceAll('rs', '');
  let out = '';
  let seenDot = false;
  let decimals = 0;
  for (const char of text) {
    if (char === '-' && allowNegative && out === '') {
      out = '-';
      continue;
    }
    if (char >= '0' && char <= '9') {
      if (seenDot) {
        if (decimals >= 2) {
          continue;
        }
        decimals += 1;
      }
      out += char;
      continue;
    }
    if (char === '.' && !seenDot) {
      seenDot = true;
      out += '.';
    }
  }
  return out;
}

export function MoneyInput({
  id,
  label,
  value,
  onChange,
  allowNegative = false,
  name,
}: {
  id?: string;
  label: string;
  value: number | null;
  onChange: (paisa: number | null) => void;
  allowNegative?: boolean;
  name?: string;
}) {
  const { t } = useTranslation();
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const shown = draft ?? (value === null ? '' : formatEditable(value));
  const parsed =
    shown.trim() === '' ? null : parseMoneyToPaisa(shown, { allowNegative });
  const invalid = touched && shown.trim() !== '' && parsed === null;

  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-small text-text">
        {label}
      </label>
      <div
        dir="ltr"
        className="flex h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-3"
      >
        <bdi className="font-mono text-text-muted">Rs</bdi>
        <input
          id={inputId}
          name={name}
          inputMode="decimal"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-body text-text outline-none"
          value={shown}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          onMouseUp={(event) => {
            event.preventDefault();
          }}
          onBlur={() => {
            setTouched(true);
            const empty = shown.trim() === '';
            const valid =
              empty || parseMoneyToPaisa(shown, { allowNegative }) !== null;
            if (valid) {
              setDraft(null);
            }
          }}
          onChange={(event) => {
            const next = filterMoneyDraft(event.target.value, allowNegative);
            setDraft(next);
            onChange(
              next.trim() === ''
                ? null
                : parseMoneyToPaisa(next, { allowNegative }),
            );
          }}
        />
      </div>
      {invalid ? (
        <p id={errorId} className="mt-1 text-small text-danger">
          {t('errors.money_invalid')}
        </p>
      ) : null}
    </div>
  );
}
