import { describe, expect, it } from 'vitest';
import { DEXIE_SCHEMA_V14, type DexieTableName, packageName } from './index.ts';

describe('@bikri/db', () => {
  it('exposes its package name', () => {
    expect(packageName).toBe('@bikri/db');
  });

  it('exports the current Dexie schema and names its tables', () => {
    const table: DexieTableName = 'sale_lines';
    expect(DEXIE_SCHEMA_V14[table]).toBeTruthy();
    expect(DEXIE_SCHEMA_V14.outbox).toContain('tx_id');
  });
});
