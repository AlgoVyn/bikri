import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary } from '../components/classes.ts';
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
} from '../shell/devicePrefs.ts';
import { SettingsGuard } from './Guard.tsx';
import { SettingsPageLayout } from './Layout.tsx';

const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

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
  const [gap, setGap] = useState<number | null>(null);
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (stored) setForm(stored);
  }, [stored]);
  useEffect(() => {
    applyDevicePrefs(form, i18n.language);
  }, [form, i18n.language]);

  const change = (patch: Partial<DevicePrefs>) => {
    const next = { ...form, ...patch };
    setForm(next);
    applyDevicePrefs(next, i18n.language);
  };
  const save = async () => {
    await saveDevicePrefs(getDb(), form);
    toast.push(t('office.display.saved'));
  };

  return (
    <SettingsPageLayout title={t('office.display.title')}>
      <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <label className="flex flex-col gap-1 text-small">
          {t('office.display.language')}
          <select
            className={field}
            value={i18n.language}
            onChange={(event) =>
              void setLanguage(event.target.value as 'en' | 'ur' | 'roman-ur')
            }
          >
            <option value="en">{t('shell.lang_en')}</option>
            <option value="ur">{t('shell.lang_ur')}</option>
            <option value="roman-ur">{t('shell.lang_roman_ur')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.display.theme')}
          <select
            className={field}
            value={form.theme}
            onChange={(event) =>
              change({ theme: event.target.value as DevicePrefs['theme'] })
            }
          >
            <option value="system">{t('office.display.theme_system')}</option>
            <option value="light">{t('office.display.theme_light')}</option>
            <option value="dark">{t('office.display.theme_dark')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.display.text_size')}
          <select
            className={field}
            value={form.textSize}
            onChange={(event) =>
              change({
                textSize: event.target.value as DevicePrefs['textSize'],
              })
            }
          >
            <option value="100">100%</option>
            <option value="115">115%</option>
            <option value="130">130%</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.display.auto_lock')}
          <input
            type="number"
            min={0}
            max={60}
            className={field}
            value={form.autoLockMinutes}
            onChange={(event) =>
              change({
                autoLockMinutes: Math.max(
                  0,
                  Math.min(60, Number(event.target.value) || 0),
                ),
              })
            }
          />
        </label>
        <label className="flex items-center gap-2 text-small">
          <input
            type="checkbox"
            checked={form.camera}
            onChange={(event) => change({ camera: event.target.checked })}
          />
          {t('office.display.camera')}
        </label>
        <label className="flex items-center gap-2 text-small">
          <input
            type="checkbox"
            checked={form.suffixEnter}
            onChange={(event) => change({ suffixEnter: event.target.checked })}
          />
          {t('office.display.suffix_enter')}
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
