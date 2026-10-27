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

/** Feature areas whose strings load with their lazy routes, not at start (D-112). */
export const CATALOG_AREAS = ['admin', 'office'] as const;
export type CatalogArea = (typeof CATALOG_AREAS)[number];

/**
 * An area's strings for one language: `admin` = the operator console, `office` = the M3 back
 * office (sales history, refunds, udhaar, suppliers, expenses, day close, reports, labels).
 */
export async function loadAreaCatalog(
  area: CatalogArea,
  locale: LocaleCode,
): Promise<Record<string, unknown>> {
  const files = area === 'admin' ? adminFiles : officeFiles;
  return (await files[locale]()).default as Record<string, unknown>;
}

type JsonModule = Promise<{ default: unknown }>;
const adminFiles: Record<LocaleCode, () => JsonModule> = {
  en: () => import('../admin/en.json', { with: { type: 'json' } }),
  ur: () => import('../admin/ur.json', { with: { type: 'json' } }),
  'roman-ur': () =>
    import('../admin/roman-ur.json', { with: { type: 'json' } }),
};
const officeFiles: Record<LocaleCode, () => JsonModule> = {
  en: () => import('../office/en.json', { with: { type: 'json' } }),
  ur: () => import('../office/ur.json', { with: { type: 'json' } }),
  'roman-ur': () =>
    import('../office/roman-ur.json', { with: { type: 'json' } }),
};
