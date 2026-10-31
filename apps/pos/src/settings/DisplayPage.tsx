import {
  Button,
  Checkbox,
  NativeSelect,
  NumberInput,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsIcon } from '../components/icons.tsx';
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
  const loaded = useRef(false);
  useEffect(() => {
    // Load the saved prefs once. A live-query refresh after the user changes a control must
    // not snap the form back to the stored value.
    if (stored && !loaded.current) {
      loaded.current = true;
      setForm(stored);
    }
  }, [stored]);
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
    <SettingsPageLayout
      title={t('office.display.title')}
      icon={<SettingsIcon />}
    >
      <Paper withBorder p="lg">
        <Stack gap="md">
          <NativeSelect
            label={t('office.display.language')}
            value={i18n.language}
            onChange={(event) =>
              void setLanguage(
                event.currentTarget.value as 'en' | 'ur' | 'roman-ur',
              )
            }
            data={[
              { value: 'en', label: t('shell.lang_en') },
              { value: 'ur', label: t('shell.lang_ur') },
              { value: 'roman-ur', label: t('shell.lang_roman_ur') },
            ]}
          />
          <NativeSelect
            label={t('office.display.theme')}
            value={form.theme}
            onChange={(event) =>
              change({
                theme: event.currentTarget.value as DevicePrefs['theme'],
              })
            }
            data={[
              { value: 'system', label: t('office.display.theme_system') },
              { value: 'light', label: t('office.display.theme_light') },
              { value: 'dark', label: t('office.display.theme_dark') },
            ]}
          />
          <NativeSelect
            label={t('office.display.text_size')}
            value={form.textSize}
            onChange={(event) =>
              change({
                textSize: event.currentTarget.value as DevicePrefs['textSize'],
              })
            }
            data={[
              { value: '100', label: '100%' },
              { value: '115', label: '115%' },
              { value: '130', label: '130%' },
            ]}
          />
          <NumberInput
            label={t('office.display.auto_lock')}
            min={0}
            max={60}
            value={form.autoLockMinutes}
            onChange={(value) =>
              change({
                autoLockMinutes: Math.max(0, Math.min(60, Number(value) || 0)),
              })
            }
          />
          <Checkbox
            label={t('office.display.camera')}
            checked={form.camera}
            onChange={(event) =>
              change({ camera: event.currentTarget.checked })
            }
          />
          <Checkbox
            label={t('office.display.suffix_enter')}
            checked={form.suffixEnter}
            onChange={(event) =>
              change({ suffixEnter: event.currentTarget.checked })
            }
          />
          <TextInput
            label={t('office.display.scanner_test')}
            placeholder={t('office.display.scanner_placeholder')}
            styles={{
              input: { fontFamily: 'var(--mantine-font-family-monospace)' },
            }}
            onKeyDown={() => {
              const now = performance.now();
              if (last.current !== null) setGap(Math.round(now - last.current));
              last.current = now;
            }}
          />
          <Text size="sm" c="dimmed" aria-live="polite">
            {gap === null
              ? t('office.display.scanner_hint')
              : t('office.display.scanner_gap', { ms: gap })}
          </Text>
          <Button
            onClick={() => void save()}
            style={{ alignSelf: 'flex-start' }}
          >
            {t('office.display.save')}
          </Button>
        </Stack>
      </Paper>
    </SettingsPageLayout>
  );
}
