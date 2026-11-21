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
  return db.transaction('rw', mergeScope(tables, caches), async (tx) => {
    return mergeRows(tx, rows, { caches });
  });
}

describe('mergeRows', () => {
  it('locks cache stores only when the merge maintains them', () => {
    const snapshot = mergeScope(['products']);
    expect(snapshot).toEqual(
      expect.arrayContaining(['outbox', 'pull_shadow', 'kv', 'products']),
    );
    expect(snapshot).not.toContain('stock_levels');
    expect(snapshot).not.toContain('party_balances');
    const pulled = mergeScope(['products'], true);
    expect(pulled).toContain('stock_levels');
    expect(pulled).toContain('party_balances');
  });

  it('derives refund line dates from refunds on the same pull page', async () => {
    const db = await readyDb('merge-refund-dates');
    await merge(
      db,
      [
        {
          tbl: 'refunds',
          row: row('r1', {
            sale_id: 's1',
            business_date: '2026-10-27',
            kind: 'partial',
            method: 'cash',
            amount: 100,
            exact_amount: 100,
            udhaar_part: 0,
            rounding: 0,
            branch_id: 'b1',
            device_id: 'd1',
            staff_id: 'st1',
            created_at: 100,
          }),
        },
        {
          tbl: 'refund_lines',
          row: row('rl1', {
            refund_id: 'r1',
            sale_line_id: 'sl1',
            qty_milli: 1000,
            amount: 100,
            restock: 1,
            created_at: 100,
          }),
        },
      ],
      false,
    );
    expect((await db.refund_lines.get('rl1'))?.business_date).toBe(
      '2026-10-27',
    );
  });

  it('recomputes a party once when a page carries several ledger rows', async () => {
    const db = await readyDb('merge-ledger-batch');
    await db.ledger_entries.put(
      row('l0', {
        party_type: 'customer',
        party_id: 'c1',
        amount: 5000,
        source_type: 'sale',
        note: '',
        created_at: 100,
      }) as never,
    );
    await db.party_balances.put({
      party_type: 'customer',
      party_id: 'c1',
      balance: 5000,
      last_activity_at: 100,
      oldest_unpaid_at: 100,
      last_payment_at: null,
    });
    await merge(
      db,
      [
        {
          tbl: 'ledger_entries',
          row: row('l1', {
            party_type: 'customer',
            party_id: 'c1',
            amount: -400,
            source_type: 'payment',
            note: '',
            created_at: 200,
          }),
        },
        {
          tbl: 'ledger_entries',
          row: row('l2', {
            party_type: 'customer',
            party_id: 'c1',
            amount: 1000,
            source_type: 'sale',
            note: '',
            created_at: 300,
          }),
        },
      ],
      true,
    );
    expect(await db.party_balances.get(['customer', 'c1'])).toMatchObject({
      balance: 5600,
    });
  });

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

  it('merges a 500-row page with a 2k backlog without a status anyOf cursor', {
    timeout: 30_000,
  }, async () => {
    const db = await readyDb('merge-backlog');
    await db.outbox.bulkAdd(
      Array.from({ length: 2_000 }, (_, i) => ({
        op_id: `op-${i}`,
        tx_id: `tx-${i}`,
        tbl: 'products',
        kind: 'upsert',
        row_id: `product-${i}`,
        row: { id: `product-${i}` },
        created_at: 1,
        status: 'pending',
        attempts: 0,
      })) as never,
    );
    const rows = Array.from({ length: 500 }, (_, i) => ({
      tbl: 'sale_lines',
      row: row(`line-${i}`, {
        sale_id: `sale-${i}`,
        qty_milli: 1000,
        created_at: 1,
      }),
    }));
    const started = performance.now();
    expect(await merge(db, rows, false)).toBe(500);
    // anyOf('pending','sending') count + toArray took ~2.3 s here in fake-indexeddb.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(await db.sale_lines.count()).toBe(500);
  });

  it('stores the refund business date on a pulled refund line', async () => {
    const db = await readyDb('merge-refund-date');
    await db.refunds.put({
      id: 'r-1',
      sale_id: 's-1',
      business_date: '2026-10-27',
      created_at: 1,
    });
    const applied = await merge(
      db,
      [
        {
          tbl: 'refund_lines',
          row: row('rl-1', {
            refund_id: 'r-1',
            sale_line_id: 'sl-1',
            qty_milli: 1000,
            amount: 5000,
            created_at: 1,
          }),
        },
      ],
      false,
    );
    expect(applied).toBe(1);
    expect((await db.refund_lines.get('rl-1'))?.business_date).toBe(
      '2026-10-27',
    );
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
