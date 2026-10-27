import { describe, expect, it } from 'vitest';
import { isUlid, newId } from '../ids.ts';
import {
  isLedgerTable,
  isMasterTable,
  LEDGER_TABLES,
  MASTER_TABLES,
  opRow,
} from './sync.ts';

describe('ids', () => {
  it('makes sortable, unique ULIDs', () => {
    const ids = Array.from({ length: 50 }, () => newId(1_793_050_000_000));
    expect(new Set(ids).size).toBe(50);
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every(isUlid)).toBe(true);
    expect(isUlid('not-a-ulid')).toBe(false);
  });
});

describe('op tables (02 §1.1)', () => {
  it('splits master and ledger tables without overlap', () => {
    expect(MASTER_TABLES).toHaveLength(10);
    expect(LEDGER_TABLES).toHaveLength(16);
    for (const t of MASTER_TABLES) expect(isLedgerTable(t)).toBe(false);
    expect(isMasterTable('products')).toBe(true);
    expect(isLedgerTable('sales')).toBe(true);
    expect(isMasterTable('devices')).toBe(false);
    expect(isLedgerTable('outbox')).toBe(false);
  });

  it('never sends tenant_id, rev or server-managed columns', () => {
    expect(
      opRow('products', {
        id: 'p',
        tenant_id: 't',
        rev: 3,
        avg_cost: 9,
        price: 1,
      }),
    ).toEqual({ id: 'p', price: 1 });
    expect(opRow('sales', { id: 's', status: 'paid', total: 5 })).toEqual({
      id: 's',
      total: 5,
    });
  });
});
