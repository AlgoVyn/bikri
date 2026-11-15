import type { SyncedRow } from '@bikri/db';
import { afterEach, describe, expect, it } from 'vitest';
import { dropTestDbs } from '../data/testDb.ts';
import { readyDb } from '../data/testShop.ts';
import { mergeRows, mergeScope, PullRowError } from './merge.ts';

afterEach(dropTestDbs);

const row = (id: string, extra: Record<string, unknown> = {}): SyncedRow =>
  ({ id, ...extra }) as SyncedRow;

async function merge(
  db: Awaited<ReturnType<typeof readyDb>>,
  rows: { tbl: string; row: SyncedRow }[],
  caches: boolean,
) {
  const tables = new Set(rows.map((r) => r.tbl));
  return db.transaction('rw', mergeScope(tables), async (tx) => {
    return mergeRows(tx, rows, { caches });
  });
}

describe('mergeRows', () => {
  it('scans a large page once and bulk-writes sale lines', async () => {
    const db = await readyDb('merge-large');
    const rows = Array.from({ length: 250 }, (_, i) => ({
      tbl: 'sale_lines',
      row: row(`line-${i}`, {
        sale_id: `sale-${i}`,
        qty_milli: 1000,
        created_at: 1,
      }),
    }));
    expect(await merge(db, rows, false)).toBe(250);
    expect(await db.sale_lines.count()).toBe(250);
  });

  it('keeps the local sale status and updates the local device row', async () => {
    const db = await readyDb('merge-status');
    await db.sales.put({
      id: 's-1',
      status: 'part_refunded',
      total: 100,
      created_at: 1,
    });
    const applied = await merge(
      db,
      [
        {
          tbl: 'sales',
          row: row('s-1', { status: 'paid', total: 100, created_at: 1 }),
        },
        {
          tbl: 'devices',
          row: row('dev-1', {
            name: 'Counter 2',
            device_code: 'B',
            branch_id: 'br-1',
            is_admin: 1,
          }),
        },
      ],
      true,
    );
    expect(applied).toBe(2);
    expect((await db.sales.get('s-1'))?.status).toBe('part_refunded');
    expect((await db.kv.get('device'))?.value).toMatchObject({
      id: 'dev-1',
      name: 'Counter 2',
      code: 'B',
    });
  });

  it('stores a pending row in pull_shadow and applies the others', async () => {
    const db = await readyDb('merge-pending');
    await db.outbox.add({
      op_id: 'op-1',
      tx_id: 'tx-1',
      tbl: 'products',
      kind: 'upsert',
      row_id: 'p-1',
      row: { id: 'p-1' },
      base_rev: 0,
      changed_fields: [],
      created_at: 1,
      status: 'pending',
      attempts: 0,
    } as never);
    expect(
      await merge(
        db,
        [
          { tbl: 'products', row: row('p-1', { name_en: 'Server' }) },
          { tbl: 'products', row: row('p-2', { name_en: 'Other' }) },
        ],
        false,
      ),
    ).toBe(1);
    expect(await db.products.get('p-1')).toBeUndefined();
    expect((await db.pull_shadow.get(['products', 'p-1']))?.row.id).toBe('p-1');
    expect(await db.products.get('p-2')).toBeDefined();
  });

  it('does not double-count a replayed stock movement', async () => {
    const db = await readyDb('merge-stock');
    await merge(
      db,
      [
        {
          tbl: 'stock_movements',
          row: row('m-1', { product_id: 'p-1', qty_delta_milli: 1000 }),
        },
      ],
      true,
    );
    expect((await db.stock_levels.get('p-1'))?.on_hand_milli).toBe(1000);
    await merge(
      db,
      [
        {
          tbl: 'stock_movements',
          row: row('m-1', { product_id: 'p-1', qty_delta_milli: 1000 }),
        },
      ],
      true,
    );
    expect((await db.stock_levels.get('p-1'))?.on_hand_milli).toBe(1000);
  });

  it('applies ledger caches and quarantines a malformed row', async () => {
    const db = await readyDb('merge-ledger');
    await merge(
      db,
      [
        {
          tbl: 'ledger_entries',
          row: row('l-1', {
            party_type: 'customer',
            party_id: 'c-1',
            amount: 500,
            created_at: 1,
          }),
        },
        {
          tbl: 'ledger_entries',
          row: row('l-2', {
            party_type: 'customer',
            party_id: 'c-1',
            amount: -200,
            created_at: 2,
          }),
        },
      ],
      true,
    );
    expect((await db.party_balances.get(['customer', 'c-1']))?.balance).toBe(
      300,
    );
    await expect(
      merge(db, [{ tbl: 'products', row: row('bad', { price: 1.5 }) }], false),
    ).rejects.toBeInstanceOf(PullRowError);
  });

  it('uses the keyed outbox probe when a large backlog would be worse', {
    timeout: 30_000,
  }, async () => {
    const db = await readyDb('merge-backlog');
    await db.outbox.bulkAdd(
      Array.from({ length: 2_001 }, (_, i) => ({
        op_id: `op-${i}`,
        tx_id: `tx-${i}`,
        tbl: 'products',
        kind: 'upsert',
        row_id: `p-${i}`,
        row: { id: `p-${i}` },
        base_rev: 0,
        changed_fields: [],
        created_at: i,
        status: 'pending',
        attempts: 0,
      })) as never,
    );
    const rows = Array.from({ length: 250 }, (_, i) => ({
      tbl: 'products',
      row: row(`p-${3_000 + i}`, { name_en: `New ${i}` }),
    }));
    expect(await merge(db, rows, false)).toBe(250);
    expect(await db.products.get('p-3000')).toBeDefined();
    expect(await db.pull_shadow.count()).toBe(0);
  });
});
