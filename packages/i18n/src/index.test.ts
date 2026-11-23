import { describe, expect, it } from 'vitest';
import { compareCatalogs, duplicateJsonKeys } from './check-keys.ts';
import {
  type LocaleCode,
  loadAllCatalogs,
  loadAreaCatalog,
  loadCatalog,
} from './index.ts';

describe('@bikri/i18n catalogs', () => {
  it('ships identical non-empty keys for en, ur and roman-ur', async () => {
    expect(compareCatalogs(await loadAllCatalogs())).toEqual([]);
  });

  it('detects duplicate keys that JSON.parse would silently drop', () => {
    expect(duplicateJsonKeys('{"a":"x","b":{"c":"y","c":"z"}}')).toEqual(['c']);
    expect(duplicateJsonKeys('{"a":"x","a":"y"}')).toEqual(['a']);
    expect(duplicateJsonKeys('{"a":"x","b":[{"c":"y"}]}')).toEqual([]);
  });

  it('flags malformed placeholder braces', () => {
    expect(
      compareCatalogs({
        en: { k: 'Hi {{name}}' },
        ur: { k: 'Hi {{name}' },
      }),
    ).toContain('ur malformed placeholders k');
  });

  it('loads one language on demand', async () => {
    const ur = await loadCatalog('ur');
    expect(ur.common.app_name).toBeTruthy();
    expect(Object.keys(ur)).toEqual(Object.keys(await loadCatalog('en')));
  });

  it('loads each area and falls back to English for an unsupported locale', async () => {
    const english = await loadAreaCatalog('office', 'en');
    expect(english.office).toBeTruthy();
    for (const area of ['admin', 'office', 'public'] as const) {
      expect(await loadAreaCatalog(area, 'roman-UR' as LocaleCode)).toEqual(
        await loadAreaCatalog(area, 'en'),
      );
      expect(await loadAreaCatalog(area, 'fr' as LocaleCode)).toEqual(
        await loadAreaCatalog(area, 'en'),
      );
    }
  });
});
