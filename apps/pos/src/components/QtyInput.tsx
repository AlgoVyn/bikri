import {
  formatQtyFromMilli,
  parseQtyToMilli,
  type QtyUnit,
  qtyAllowsDecimals,
} from '@bikri/core';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet, buttonQuietDense } from './classes.ts';

const STEP_MILLI = 1000;

function clampMilli(value: number): number {
  return Math.max(value, 0);
}

export function QtyInput({
  id,
  label,
  ariaLabel,
  unit,
  value,
  onChange,
  name,
  dense = false,
  hideLabel = false,
  commitOnBlur = false,
}: {
  id?: string;
  label: string;
  /** Accessible name when the visible label is short (e.g. a cart line). */
  ariaLabel?: string;
  unit: QtyUnit;
  value: number | null;
  onChange: (milli: number | null) => void;
  name?: string;
  /** 44 px controls for dense rows (cart lines, stock count, labels). */
  dense?: boolean;
  /** Keep the label for assistive tech only; the row already gives the context. */
  hideLabel?: boolean;
  /** Write only on blur/Enter instead of every keystroke (cart lines, bundle qty). */
  commitOnBlur?: boolean;
}) {
  const { t } = useTranslation();
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelCommit = () => {
    if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    commitTimer.current = null;
  };
  useEffect(
    () => () => {
      if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    },
    [],
  );
  const shown =
    draft ?? (value === null ? '' : formatQtyFromMilli(value, unit));
  const parsed = shown.trim() === '' ? null : parseQtyToMilli(shown, unit);
  const invalid = touched && shown.trim() !== '' && parsed === null;

  function commit(next: number | null) {
    cancelCommit();
    setDraft(null);
    onChange(next);
  }

  function step(direction: 1 | -1) {
    const base = parsed ?? value ?? 0;
    commit(clampMilli(base + direction * STEP_MILLI));
  }

  return (
    <div className="min-w-0">
      <label
        htmlFor={inputId}
        className={hideLabel ? 'sr-only' : 'mb-1 block text-small text-text'}
      >
        {label}
      </label>
      <div
        className={
          dense ? 'flex items-center gap-1' : 'flex items-center gap-2'
        }
      >
        <button
          type="button"
          className={dense ? buttonQuietDense : buttonQuiet}
          aria-label={t('ui.qty_decrease')}
          onClick={() => {
            step(-1);
          }}
        >
          −
        </button>
        <input
          id={inputId}
          dir="ltr"
          name={name}
          aria-label={ariaLabel}
          inputMode={qtyAllowsDecimals(unit) ? 'decimal' : 'numeric'}
          autoComplete="off"
          className={`${dense ? 'h-12 px-2 text-small' : 'h-11 px-3 text-body'} min-w-0 flex-1 rounded-control border border-border-strong bg-surface text-center font-mono text-text outline-none`}
          value={shown}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          onBlur={() => {
            setTouched(true);
            const empty = shown.trim() === '';
            const valid = empty || parseQtyToMilli(shown, unit) !== null;
            if (valid) {
              cancelCommit();
              if (commitOnBlur)
                onChange(empty ? null : parseQtyToMilli(shown, unit));
              setDraft(null);
            }
          }}
          onKeyDown={(event) => {
            if (commitOnBlur && event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            if (event.key === '+' || event.key === '-') {
              event.preventDefault();
              step(event.key === '+' ? 1 : -1);
            }
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            const next = parseQtyToMilli(event.target.value, unit);
            if (!commitOnBlur) {
              onChange(next);
              return;
            }
            // A short pause commits one cart write instead of one per digit; blur and
            // Enter commit immediately.
            cancelCommit();
            commitTimer.current = setTimeout(() => onChange(next), 200);
          }}
        />
        <button
          type="button"
          className={dense ? buttonQuietDense : buttonQuiet}
          aria-label={t('ui.qty_increase')}
          onClick={() => {
            step(1);
          }}
        >
          +
        </button>
      </div>
      {invalid ? (
        <p id={errorId} className="mt-1 text-small text-danger">
          {t('errors.qty_invalid')}
        </p>
      ) : null}
    </div>
  );
}
