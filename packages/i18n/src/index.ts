import en from '../en.json' with { type: 'json' };
import romanUr from '../roman-ur.json' with { type: 'json' };
import ur from '../ur.json' with { type: 'json' };

export const catalogs = {
  en,
  ur,
  'roman-ur': romanUr,
} as const;

export type LocaleCode = keyof typeof catalogs;
export type Catalog = typeof en;
