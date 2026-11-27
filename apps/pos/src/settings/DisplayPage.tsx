import { normaliseNumericText } from '@bikri/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary } from '../components/classes.ts';
import { DisplayIcon } from '../components/icons.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { setLanguage } from '../i18n/i18n.ts';
import {
  applyDevicePrefs,
  DEFAULT_PREFS,
  type DevicePrefs,
  loadDevicePrefs,
  saveDevicePrefs,
  setPrivacyMode,
} from '../shell/devicePrefs.ts';
import { SettingsGuard } from './Guard.tsx';
import { SettingsPageLayout } from './Layout.tsx';

const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

/** A 2–3 option device setting reads faster as a segmented control than a select. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1 text-small">
      <legend>{label}</legend>
      <div className="flex flex-wrap gap-1 rounded-control border border-border-strong bg-surface p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            className={`min-h-11 rounded-md px-3 text-small font-medium transition-colors ${
              value === option.value
                ? 'bg-primary text-primary-ink'
                : 'text-text-muted hover:bg-surface-2'
            }`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Language, display, auto-lock and scanner test for this device (screens/17). */
export function DisplayPage() {
  return (
    <AreaStrings area="office">
      <SettingsGuard permission="settings.device">
        <DisplayContent />
      </SettingsGuard>
    </AreaStrings>
  );
}

function DisplayContent() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const stored = useLiveQuery(() => loadDevicePrefs(getDb()), []);
  const [form, setForm] = useState<DevicePrefs>(DEFAULT_PREFS);
  const touched = useRef(false);
  const [gap, setGap] = useState<number | null>(null);
  const last = useRef<number | null>(null);
  const [autoLockText, setAutoLockText] = useState(
    String(DEFAULT_PREFS.autoLockMinutes),
  );
  const saved = useRef<DevicePrefs>(DEFAULT_PREFS);
  useEffect(() => {
    if (!stored) return;
    saved.current = stored;
    setForm((current) =>
      touched.current
        ? current.privacyMode === stored.privacyMode
          ? current
          : { ...current, privacyMode: stored.privacyMode }
        : stored,
    );
    if (!touched.current) setAutoLockText(String(stored.autoLockMinutes));
  }, [stored]);
  useEffect(() => {
    applyDevicePrefs(form, i18n.language);
  }, [form, i18n.language]);
  // A preview that was never saved must not survive navigation: another screen would
  // keep the unsaved theme/font-size until reload (screens/17).
  useEffect(
    () => () => {
      applyDevicePrefs(saved.current, i18n.language);
    },
    [i18n.language],
  );

  const change = (patch: Partial<DevicePrefs>) => {
    touched.current = true;
    const next = { ...form, ...patch };
    setForm(next);
    applyDevicePrefs(next, i18n.language);
  };
  const save = async () => {
    await saveDevicePrefs(getDb(), form);
    saved.current = form;
    toast.push(t('office.display.saved'));
  };

  return (
    <SettingsPageLayout
      title={t('office.display.title')}
      icon={<DisplayIcon />}
    >
      <section className="flex w-full flex-col gap-3 rounded-card border border-divider bg-surface p-4">
        <Segmented
          label={t('office.display.language')}
          value={i18n.language}
          options={[
            { value: 'en', label: t('shell.lang_en') },
            { value: 'ur', label: t('shell.lang_ur') },
            { value: 'roman-ur', label: t('shell.lang_roman_ur') },
          ]}
          onChange={(value) =>
            void setLanguage(value as 'en' | 'ur' | 'roman-ur')
          }
        />
        <Segmented
          label={t('office.display.theme')}
          value={form.theme}
          options={[
            { value: 'system', label: t('office.display.theme_system') },
            { value: 'light', label: t('office.display.theme_light') },
            { value: 'dark', label: t('office.display.theme_dark') },
          ]}
          onChange={(value) => change({ theme: value })}
        />
        <Segmented
          label={t('office.display.text_size')}
          value={form.textSize}
          options={[
            { value: '100', label: '100%' },
            { value: '115', label: '115%' },
            { value: '130', label: '130%' },
          ]}
          onChange={(value) => change({ textSize: value })}
        />
        <Segmented
          label={t('office.display.cart_order')}
          value={form.cartOrder}
          options={[
            {
              value: 'newest_first',
              label: t('office.display.cart_order_first'),
            },
            {
              value: 'newest_last',
              label: t('office.display.cart_order_last'),
            },
          ]}
          onChange={(value) => change({ cartOrder: value })}
        />
        <Segmented
          label={t('office.display.keypad')}
          value={form.keypad}
          options={[
            { value: 'phone', label: t('office.display.keypad_phone') },
            {
              value: 'computer',
              label: t('office.display.keypad_computer'),
            },
          ]}
          onChange={(value) => change({ keypad: value })}
        />
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            className="size-5 shrink-0"
            checked={form.privacyMode}
            data-testid="privacy-setting"
            onChange={(event) => {
              const value = event.target.checked;
              change({ privacyMode: value });
              void setPrivacyMode(getDb(), value).catch(() =>
                toast.push(t('errors.generic'), 'error'),
              );
            }}
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t('privacy.title')}</span>
            <span className="text-text-muted">{t('privacy.hint')}</span>
          </span>
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.display.auto_lock')}
          <input
            type="number"
            min={0}
            max={60}
            className={field}
            value={autoLockText}
            onChange={(event) => {
              const text = normaliseNumericText(event.target.value).replace(
                /\D/gu,
                '',
              );
              setAutoLockText(text);
              // Clearing the field must not snap to 0 while the cashier retypes.
              if (text !== '')
                change({
                  autoLockMinutes: Math.max(0, Math.min(60, Number(text))),
                });
            }}
            onBlur={() => {
              if (autoLockText === '') {
                setAutoLockText(String(form.autoLockMinutes));
                return;
              }
              const minutes = Math.max(0, Math.min(60, Number(autoLockText)));
              setAutoLockText(String(minutes));
              if (minutes !== form.autoLockMinutes)
                change({ autoLockMinutes: minutes });
            }}
          />
        </label>
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            className="size-5 shrink-0"
            checked={form.camera}
            onChange={(event) => change({ camera: event.target.checked })}
          />
          {t('office.display.camera')}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            className="size-5 shrink-0"
            checked={form.suffixEnter}
            onChange={(event) => change({ suffixEnter: event.target.checked })}
          />
          {t('office.display.suffix_enter')}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            className="size-5 shrink-0"
            checked={form.saleSound}
            onChange={(event) => change({ saleSound: event.target.checked })}
          />
          {t('office.display.sale_sound')}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            className="size-5 shrink-0"
            checked={form.autoClose}
            onChange={(event) => change({ autoClose: event.target.checked })}
          />
          {t('office.display.auto_close')}
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.display.scanner_test')}
          <input
            className={`${field} font-mono`}
            placeholder={t('office.display.scanner_placeholder')}
            onKeyDown={() => {
              const now = performance.now();
              if (last.current !== null) setGap(Math.round(now - last.current));
              last.current = now;
            }}
          />
        </label>
        <p className="text-small text-text-muted" aria-live="polite">
          {gap === null
            ? t('office.display.scanner_hint')
            : t('office.display.scanner_gap', { ms: gap })}
        </p>
        <button
          type="button"
          className={`${buttonPrimary} self-start`}
          onClick={() => void save()}
        >
          {t('office.display.save')}
        </button>
      </section>
    </SettingsPageLayout>
  );
}
