import { NativeSelect } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { isLocale, setLanguage } from '../i18n/i18n.ts';

/** en / ur / roman-ur switcher (shell header, enrol screen). */
export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  const language = isLocale(i18n.language) ? i18n.language : 'en';
  return (
    <NativeSelect
      aria-label={t('shell.language')}
      size="xs"
      w={{ base: 110, sm: 132 }}
      value={language}
      data={[
        { value: 'en', label: t('shell.lang_en') },
        { value: 'ur', label: t('shell.lang_ur') },
        { value: 'roman-ur', label: t('shell.lang_roman_ur') },
      ]}
      onChange={(event) => {
        const next = event.currentTarget.value;
        if (isLocale(next)) void setLanguage(next);
      }}
      styles={{ input: { minHeight: 36 } }}
    />
  );
}
