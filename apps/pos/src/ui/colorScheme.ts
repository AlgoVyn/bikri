import type { MantineColorSchemeManager } from '@mantine/core';
import {
  applyStoredTheme,
  storedTheme,
  THEME_STORAGE_KEY,
} from '../shell/devicePrefs.ts';

/**
 * One theme setting for two systems. Bikri stores `system | light | dark`; Mantine calls
 * the same values `auto | light | dark`. The manager keeps `bikri.theme` authoritative and
 * mirrors the resolved attributes so Tailwind tokens and Mantine components cannot drift.
 */
export const bikriColorSchemeManager: MantineColorSchemeManager = {
  get: (defaultValue) => {
    const theme = storedTheme();
    if (theme === 'system') return 'auto';
    if (theme === 'light' || theme === 'dark') return theme;
    return defaultValue;
  },
  set: (value) => {
    try {
      localStorage.setItem(
        THEME_STORAGE_KEY,
        value === 'auto' ? 'system' : value,
      );
    } catch {
      // Storage can be disabled; the in-memory scheme still changes.
    }
    applyStoredTheme();
  },
  subscribe: (onUpdate) => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      applyStoredTheme();
      onUpdate(
        event.newValue === 'light' || event.newValue === 'dark'
          ? event.newValue
          : 'auto',
      );
    };
    window.addEventListener('storage', onStorage);
  },
  unsubscribe: () => {
    // The provider owns the listener lifecycle; the manager is a singleton and the
    // storage listener is harmless for the lifetime of the app.
  },
  clear: () => {
    try {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } catch {
      // Ignore disabled storage.
    }
    applyStoredTheme();
  },
};
