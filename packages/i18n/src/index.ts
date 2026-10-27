import type en from '../en.json';

export const LOCALE_CODES = ['en', 'ur', 'roman-ur'] as const;
export type LocaleCode = (typeof LOCALE_CODES)[number];
export type Catalog = typeof en;

/**
 * One catalog per language, loaded on demand (D-100): the app downloads only the active
 * language at start instead of all three, which keeps the initial bundle small.
 */
export async function loadCatalog(locale: LocaleCode): Promise<Catalog> {
  switch (locale) {
    case 'ur':
      return (await import('../ur.json', { with: { type: 'json' } })).default;
    case 'roman-ur':
      return (await import('../roman-ur.json', { with: { type: 'json' } }))
        .default as Catalog;
    default:
      return (await import('../en.json', { with: { type: 'json' } })).default;
  }
}

/** All catalogs at once (tests, key checks and the dev UI kit only). */
export async function loadAllCatalogs(): Promise<Record<LocaleCode, Catalog>> {
  const [en, ur, romanUr] = await Promise.all(LOCALE_CODES.map(loadCatalog));
  return {
    en: en as Catalog,
    ur: ur as Catalog,
    'roman-ur': romanUr as Catalog,
  };
}
