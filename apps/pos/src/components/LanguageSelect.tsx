import type { LocaleCode } from '@bikri/i18n';
import { useTranslation } from 'react-i18next';
import { isLocale, setLanguage } from '../i18n/i18n.ts';
import { CheckIcon } from './icons.tsx';

const LANGUAGES: readonly { id: LocaleCode; label: string }[] = [
  { id: 'en', label: 'shell.lang_en' },
  { id: 'ur', label: 'shell.lang_ur' },
  { id: 'roman-ur', label: 'shell.lang_roman_ur' },
];

/** en / ur / roman-ur switcher (shell header, enrol screen). */
export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  const language = isLocale(i18n.language) ? i18n.language : 'en';
  return (
    <label className="inline-flex items-center">
      <span className="sr-only">{t('shell.language')}</span>
      <select
        className="h-11 max-w-24 rounded-control border border-border-strong bg-surface px-1 text-text max-lg:max-w-20"
        value={language}
        onChange={(event) => {
          const next = event.target.value;
          if (isLocale(next)) void setLanguage(next);
        }}
      >
        {LANGUAGES.map((language) => (
          <option key={language.id} value={language.id}>
            {t(language.label)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Language choices as menu rows, for the staff menu. A native select inside a
 * 224 px popover reads as a form field; a checked radio list reads as a menu.
 */
export function LanguageMenu({ onPicked }: { onPicked?: () => void }) {
  const { t, i18n } = useTranslation();
  const language = isLocale(i18n.language) ? i18n.language : 'en';
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-1 px-2 text-caption font-semibold uppercase tracking-[0.12em] text-text-muted">
        {t('shell.language')}
      </legend>
      {LANGUAGES.map((item) => {
        const active = item.id === language;
        return (
          <label
            key={item.id}
            className={`flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-control px-2 text-small transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary/40 ${
              active
                ? 'bg-primary-subtle font-medium text-primary-subtle-ink'
                : 'text-text hover:bg-surface-2'
            }`}
          >
            <input
              type="radio"
              name="bikri-language"
              value={item.id}
              checked={active}
              className="sr-only"
              onChange={() => {
                void setLanguage(item.id);
                onPicked?.();
              }}
            />
            <span className="flex-1">{t(item.label)}</span>
            {active ? (
              <CheckIcon className="size-4 shrink-0" />
            ) : (
              <span aria-hidden="true" className="size-4 shrink-0" />
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
