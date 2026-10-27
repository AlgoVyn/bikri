import { useTranslation } from 'react-i18next';
import { isLocale, setLanguage } from '../i18n/i18n.ts';

/** en / ur / roman-ur switcher (shell header, enrol screen). */
export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  const language = isLocale(i18n.language) ? i18n.language : 'en';
  return (
    <label className="inline-flex items-center">
      <span className="sr-only">{t('shell.language')}</span>
      <select
        className="h-11 max-w-24 rounded-control border border-border-strong bg-surface px-1 text-text"
        value={language}
        onChange={(event) => {
          const next = event.target.value;
          if (isLocale(next)) void setLanguage(next);
        }}
      >
        <option value="en">{t('shell.lang_en')}</option>
        <option value="ur">{t('shell.lang_ur')}</option>
        <option value="roman-ur">{t('shell.lang_roman_ur')}</option>
      </select>
    </label>
  );
}
