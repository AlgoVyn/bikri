import { describe, expect, it } from 'vitest';
import { compareCatalogs } from './check-keys.ts';
import { loadAllCatalogs, loadCatalog } from './index.ts';

describe('@bikri/i18n catalogs', () => {
  it('ships identical non-empty keys for en, ur and roman-ur', async () => {
    expect(compareCatalogs(await loadAllCatalogs())).toEqual([]);
  });

  it('loads one language on demand', async () => {
    const ur = await loadCatalog('ur');
    expect(ur.common.app_name).toBeTruthy();
    expect(Object.keys(ur)).toEqual(Object.keys(await loadCatalog('en')));
  });
});
