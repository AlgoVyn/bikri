import { normaliseNumericText, parseMoneyToPaisa } from '@bikri/core';
import { type ReactNode, useId, useState } from 'react';
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
  large = false,
  name,
  trailing,
  leading,
  placeholder,
  compact = false,
}: {
  id?: string;
  label: string;
  value: number | null;
  onChange: (paisa: number | null) => void;
  allowNegative?: boolean;
  /** Taller, larger field for the amount that matters (e.g. cash received). */
  large?: boolean;
  name?: string;
  /** Small control beside the label (e.g. a hint). */
  trailing?: ReactNode;
  /** Full-height control at the start of the field (e.g. the Rs/% switch); replaces the Rs prefix. */
  leading?: ReactNode;
  placeholder?: string;
  /** 36 px field whose label is for assistive tech only (dense cart rows). */
  compact?: boolean;
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
      <div
        className={
          compact ? 'sr-only' : 'mb-1 flex items-center justify-between gap-1'
        }
      >
        <label htmlFor={inputId} className="block text-small text-text">
          {label}
        </label>
        {trailing}
      </div>
      <div
        dir="ltr"
        className={`flex items-stretch rounded-control border border-border-strong bg-surface ${compact ? 'h-9' : large ? 'h-14' : 'h-11'}`}
      >
        {leading ?? (
          <bdi
            className={`flex shrink-0 items-center font-mono text-text-muted ${compact ? 'ps-2 text-small' : 'ps-3'}`}
          >
            Rs
          </bdi>
        )}
        <input
          id={inputId}
          name={name}
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder}
          className={`min-w-0 flex-1 bg-transparent font-mono text-text outline-none placeholder:text-text-muted ${compact ? 'text-small' : large ? 'text-title' : 'text-body'} ${leading ? (compact ? 'px-1' : 'px-3') : compact ? 'ps-1 pe-2' : 'ps-2 pe-3'}`}
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
