import { type PhoneKind, parsePkPhone, whatsAppUrl } from '@bikri/core';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fieldClass } from './classes.ts';

export function PhoneInput({
  id,
  label,
  kind = 'mobile',
  value,
  onChange,
  name,
  required = false,
}: {
  id?: string;
  label: string;
  kind?: PhoneKind;
  value: string;
  onChange: (e164: string | null) => void;
  name?: string;
  /** Visible required mark next to the label. */
  required?: boolean;
}) {
  const { t } = useTranslation();
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = `${inputId}-error`;
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const parsedValue = value === '' ? null : parsePkPhone(value, kind);
  const shown = draft ?? parsedValue?.display ?? value;
  const live = shown.trim() === '' ? null : parsePkPhone(shown, kind);
  const invalid = touched && shown.trim() !== '' && live === null;
  const whatsApp = live === null ? null : whatsAppUrl(live);

  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-small text-text">
        {label}
        {required ? (
          <span className="text-danger">
            <span aria-hidden="true"> *</span>
            <span className="sr-only"> ({t('common.required')})</span>
          </span>
        ) : null}
      </label>
      <input
        id={inputId}
        name={name}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        dir="ltr"
        className={fieldClass}
        value={shown}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onFocus={() => {
          setDraft(shown);
        }}
        onBlur={() => {
          setTouched(true);
          const empty = shown.trim() === '';
          const valid = empty || parsePkPhone(shown, kind) !== null;
          if (valid) {
            setDraft(null);
          }
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = next.trim() === '' ? null : parsePkPhone(next, kind);
          onChange(parsed === null ? null : parsed.e164);
        }}
      />
      {invalid ? (
        <p id={errorId} className="mt-1 text-small text-danger">
          {t('errors.phone_invalid')}
        </p>
      ) : null}
      {whatsApp !== null ? (
        <a
          className="mt-1 inline-flex min-h-11 items-center text-primary"
          href={whatsApp}
          rel="noopener noreferrer"
        >
          {t('ui.phone_whatsapp')}
        </a>
      ) : null}
    </div>
  );
}
