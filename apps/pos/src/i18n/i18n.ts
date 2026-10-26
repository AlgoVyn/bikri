import { catalogs, type LocaleCode } from '@bikri/i18n';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

export const LANGUAGE_KEY = 'bikri.language';
export const LOCALES = ['en', 'ur', 'roman-ur'] as const;

export function isLocale(value: string | null): value is LocaleCode {
  return value === 'en' || value === 'ur' || value === 'roman-ur';
}

export function readStoredLanguage(): LocaleCode {
  if (typeof localStorage === 'undefined') {
    return 'en';
  }
  const stored = localStorage.getItem(LANGUAGE_KEY);
  return isLocale(stored) ? stored : 'en';
}

export function applyDocumentLanguage(locale: LocaleCode): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ur' ? 'rtl' : 'ltr';
}

export async function setLanguage(locale: LocaleCode): Promise<void> {
  localStorage.setItem(LANGUAGE_KEY, locale);
  await i18n.changeLanguage(locale);
  applyDocumentLanguage(locale);
}

export async function initI18n(locale?: LocaleCode): Promise<void> {
  const language = locale ?? readStoredLanguage();
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources: {
        en: { translation: catalogs.en },
        ur: { translation: catalogs.ur },
        'roman-ur': { translation: catalogs['roman-ur'] },
      },
      lng: language,
      fallbackLng: 'en',
      supportedLngs: [...LOCALES],
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  } else if (i18n.language !== language) {
    await i18n.changeLanguage(language);
  }
  applyDocumentLanguage(language);
}
