import { describe, expect, it } from 'vitest';
import { compareCatalogs, duplicateJsonKeys } from './check-keys.ts';
import { loadAllCatalogs, loadCatalog } from './index.ts';

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
    ).toContain('ur placeholders differ k');
  });

  it('loads one language on demand', async () => {
    const ur = await loadCatalog('ur');
    expect(ur.common.app_name).toBeTruthy();
    expect(Object.keys(ur)).toEqual(Object.keys(await loadCatalog('en')));
  });
});
