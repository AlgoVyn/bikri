import type { BikriDb } from '@bikri/db';
import { getKv, setKv } from '../data/kv.ts';
import { BROWSER_CHROME } from '../lib/palette.ts';

export type ThemePref = 'system' | 'light' | 'dark';
export type TextSizePref = '100' | '115' | '130';

export type DevicePrefs = {
  theme: ThemePref;
  textSize: TextSizePref;
  autoLockMinutes: number;
  camera: boolean;
  suffixEnter: boolean;
};

export const THEME_STORAGE_KEY = 'bikri.theme';

export const DEFAULT_PREFS: DevicePrefs = {
  theme: 'system',
  textSize: '100',
  autoLockMinutes: 10,
  camera: false,
  suffixEnter: true,
};

export async function loadDevicePrefs(db: BikriDb): Promise<DevicePrefs> {
  const stored = await getKv<Partial<DevicePrefs>>(db, 'ui.prefs', {});
  const autoLock = await getKv<number>(
    db,
    'auto_lock_minutes',
    DEFAULT_PREFS.autoLockMinutes,
  );
  return {
    ...DEFAULT_PREFS,
    ...stored,
    autoLockMinutes: Number(
      stored.autoLockMinutes ?? autoLock ?? DEFAULT_PREFS.autoLockMinutes,
    ),
  };
}

export async function saveDevicePrefs(
  db: BikriDb,
  prefs: DevicePrefs,
): Promise<void> {
  await setKv(db, 'ui.prefs', {
    theme: prefs.theme,
    textSize: prefs.textSize,
    autoLockMinutes: prefs.autoLockMinutes,
    camera: prefs.camera,
    suffixEnter: prefs.suffixEnter,
  });
  await setKv(db, 'auto_lock_minutes', prefs.autoLockMinutes);
}

/** Reads the device theme selected in Settings (same origin, no shop DB needed). */
export function storedTheme(): ThemePref {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system')
      return value;
  } catch {
    // Storage can be disabled.
  }
  return 'system';
}

/** Applies the device theme to the document without opening a shop database. */
function applyThemeColor(theme: ThemePref): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const dark =
    theme === 'dark' ||
    (theme === 'system' &&
      typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-color-scheme: dark)').matches);
  meta.setAttribute(
    'content',
    dark ? BROWSER_CHROME.dark : BROWSER_CHROME.light,
  );
}

export function applyStoredTheme(): void {
  const root = document.documentElement;
  const theme = storedTheme();
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  applyThemeColor(theme);
}

/** Applies theme and text size to the document (screens/17 display). */
export function applyDevicePrefs(
  prefs: Pick<DevicePrefs, 'theme' | 'textSize'>,
  lang = 'en',
): void {
  const root = document.documentElement;
  if (prefs.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  applyThemeColor(prefs.theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, prefs.theme);
  } catch {
    // Storage can be disabled; this page still uses the theme.
  }
  const base = lang === 'ur' ? 18 : 15;
  const factor = Number(prefs.textSize) / 100;
  root.style.fontSize = `${Math.round(base * factor * 100) / 100}px`;
}
