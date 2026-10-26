import { describe, expect, it } from 'vitest';
import { compareCatalogs } from './check-keys.ts';
import { catalogs } from './index.ts';

describe('@bikri/i18n catalogs', () => {
  it('ships identical non-empty keys for en, ur and roman-ur', () => {
    expect(compareCatalogs(catalogs)).toEqual([]);
  });
});
