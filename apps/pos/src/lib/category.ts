import type { MasterRow } from '@bikri/db';

/** A category's display name in the current language, falling back to English. */
export function categoryName(category: MasterRow | null, lang: string): string {
  if (!category) return '';
  if (lang === 'ur' && String(category.name_ur ?? '').trim() !== '')
    return String(category.name_ur);
  return String(category.name_en ?? '');
}
