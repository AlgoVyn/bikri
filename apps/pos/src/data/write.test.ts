import { MAX_OPS_PER_TX } from '@bikri/core';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCaches, rebuildCaches } from './caches.ts';
import { dropTestDbs, freshDb } from './testDb.ts';
import {
  RowNotFoundError,
  TooManyOpsError,
  type Writer,
  writeAction,
} from './write.ts';

afterEach(dropTestDbs);

const NOW = 1_793_050_000_000;
const base = {
  branch_id: 'b1',
  device_id: 'd1',
  staff_id: 's1',
  business_date: '2026-10-27',
};

function move(id: string, product: string, delta: number, at = NOW) {
  return {
    id,
    product_id: product,
    qty_delta_milli: delta,
    reason_code: 'sale',
    note: '',
    created_at: at,
    ...base,
  };
}
function entry(id: string, party: string, amount: number, at: number) {
  return {
    id,
    party_type: 'customer',
    party_id: party,
    amount,
    source_type: 'sale',
    note: '',
    created_at: at,
    ...base,
  };
}

describe('writeAction (03 §3)', () => {
  it('writes rows and outbox ops in one transaction sharing a tx_id', async () => {
    const db = freshDb();
    const product = await writeAction(
      db,
      async (w) => {
        const p = await w.create('products', {
          name_en: 'Phone X',
          sku: 'PHO-1',
          price: 100,
          tenant_id: 'evil',
        });
        await w.insert('stock_movements', move('m1', p.id, 5000));
        return p;
      },
      { now: NOW, actor: 's1' },
    );
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(2);
    expect(new Set(ops.map((o) => o.tx_id)).size).toBe(1);
    expect(ops[0]).toMatchObject({
      tbl: 'products',
      kind: 'upsert',
      base_rev: 0,
      changed_fields: [],
      status: 'pending',
      attempts: 0,
    });
    expect(ops[0]?.row).not.toHaveProperty('tenant_id');
    expect(ops[0]?.row).not.toHaveProperty('rev');
    expect(ops[1]).toMatchObject({
      tbl: 'stock_movements',
      kind: 'insert',
      row_id: 'm1',
    });
    expect(product).toMatchObject({
      rev: 0,
      created_at: NOW,
      updated_by: 's1',
      deleted_at: null,
    });
    expect(await db.stock_levels.get(product.id)).toEqual({
      product_id: product.id,
      on_hand_milli: 5000,
    });
  });

  it('an aborted action leaves neither rows, ops nor cache changes', async () => {
    const db = freshDb();
    await expect(
      writeAction(db, async (w) => {
        await w.create('products', { id: 'p1', name_en: 'X', sku: 'X-1' });
        await w.insert('stock_movements', move('m1', 'p1', 1000));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.products.count()).toBe(0);
    expect(await db.stock_movements.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.stock_levels.count()).toBe(0);
  });

  it('a duplicate ledger id aborts the whole action', async () => {
    const db = freshDb();
    await writeAction(db, (w) =>
      w.insert('stock_movements', move('m1', 'p1', 1000)),
    );
    await expect(
      writeAction(db, async (w) => {
        await w.insert('stock_movements', move('m2', 'p1', 1000));
        await w.insert('stock_movements', move('m1', 'p1', 1000));
      }),
    ).rejects.toThrow();
    expect(await db.outbox.count()).toBe(1);
    expect((await db.stock_levels.get('p1'))?.on_hand_milli).toBe(1000);
  });

  it(`refuses more than ${MAX_OPS_PER_TX} ops in one action`, async () => {
    const db = freshDb();
    await expect(
      writeAction(db, async (w) => {
        for (let i = 0; i <= MAX_OPS_PER_TX; i++)
          await w.insert('stock_movements', move(`m${i}`, 'p1', 1));
      }),
    ).rejects.toBeInstanceOf(TooManyOpsError);
    expect(await db.stock_movements.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    await writeAction(db, async (w) => {
      for (let i = 0; i < MAX_OPS_PER_TX; i++)
        await w.insert('stock_movements', move(`m${i}`, 'p1', 1));
      expect(w.opCount).toBe(MAX_OPS_PER_TX);
    });
    expect(await db.outbox.count()).toBe(MAX_OPS_PER_TX);
  });

  it('coalesces edits of a pending new row into its create op', async () => {
    const db = freshDb();
    await writeAction(
      db,
      (w) => w.create('products', { id: 'p1', name_en: 'X', price: 1 }),
      { now: NOW },
    );
    await writeAction(db, (w) => w.update('products', 'p1', { price: 2 }), {
      now: NOW + 1,
    });
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      base_rev: 0,
      changed_fields: [],
      row: { price: 2, updated_at: NOW + 1 },
    });
  });

  it('edits of a synced row send base_rev and the union of changed fields', async () => {
    const db = freshDb();
    await db.products.put({
      id: 'p1',
      name_en: 'X',
      price: 1,
      cost: 1,
      created_at: 1,
      updated_at: 1,
      rev: 7,
    });
    await writeAction(db, (w) =>
      w.update('products', 'p1', { price: 2, name_en: 'X' }),
    );
    await writeAction(db, (w) =>
      w.update('products', 'p1', { cost: 3, rev: 99, id: 'zz' }),
    );
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      base_rev: 7,
      changed_fields: ['price', 'cost'],
      row: { price: 2, cost: 3 },
    });
    const stored = await db.products.get('p1');
    expect(stored).toMatchObject({ id: 'p1', rev: 7, price: 2, cost: 3 });
  });

  it('a no-op edit queues nothing; a failed op is not coalesced', async () => {
    const db = freshDb();
    await db.products.put({
      id: 'p1',
      name_en: 'X',
      price: 1,
      created_at: 1,
      updated_at: 1,
      rev: 2,
    });
    await writeAction(db, (w) => w.update('products', 'p1', { price: 1 }));
    expect(await db.outbox.count()).toBe(0);
    await writeAction(db, (w) => w.update('products', 'p1', { price: 2 }));
    await db.outbox.toCollection().modify({ status: 'failed' });
    await writeAction(db, (w) => w.update('products', 'p1', { price: 3 }));
    expect(await db.outbox.count()).toBe(2);
  });

  it('soft-deletes with a delete op and never coalesces across it', async () => {
    const db = freshDb();
    await db.customers.put({
      id: 'c1',
      name: 'Ali',
      created_at: 1,
      updated_at: 1,
      rev: 3,
    });
    await writeAction(db, (w) => w.remove('customers', 'c1'), { now: NOW });
    await writeAction(db, (w) => w.remove('customers', 'c1'), { now: NOW + 5 });
    expect((await db.customers.get('c1'))?.deleted_at).toBe(NOW);
    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'delete', row_id: 'c1', base_rev: 3 });
    expect(ops[0]).not.toHaveProperty('row');
    await writeAction(db, (w) =>
      w.update('customers', 'c1', { name: 'Ali K' }),
    );
    expect(await db.outbox.count()).toBe(2);
  });

  it('keeps nested helpers inside the action through w.table', async () => {
    const db = freshDb();
    const addMoves = async (w: Writer, ids: string[]) => {
      for (const id of ids) {
        await w.insert('stock_movements', move(id, 'p1', 1000));
        const level = await w
          .table<{ on_hand_milli: number }>('stock_levels')
          .get('p1');
        expect(level?.on_hand_milli).toBeGreaterThan(0);
      }
    };
    await expect(
      writeAction(db, async (w) => {
        await addMoves(w, ['m1', 'm2']);
        await addMoves(w, ['m3']);
        throw new Error('late failure');
      }),
    ).rejects.toThrow('late failure');
    expect(await db.stock_movements.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.stock_levels.count()).toBe(0);
  });

  it('rejects edits of missing rows', async () => {
    const db = freshDb();
    await expect(
      writeAction(db, (w) => w.update('products', 'nope', { price: 1 })),
    ).rejects.toBeInstanceOf(RowNotFoundError);
    await expect(
      writeAction(db, (w) => w.remove('products', 'nope')),
    ).rejects.toBeInstanceOf(RowNotFoundError);
  });
});

describe('caches (02 §3.1, §3.2)', () => {
  it('keeps party balances and oldest unpaid in step with ledger entries', async () => {
    const db = freshDb();
    await writeAction(db, async (w) => {
      await w.insert('ledger_entries', entry('l1', 'c1', 5000, 100));
      await w.insert('ledger_entries', entry('l2', 'c1', 3000, 200));
    });
    expect(await db.party_balances.get(['customer', 'c1'])).toEqual({
      party_type: 'customer',
      party_id: 'c1',
      balance: 8000,
      last_activity_at: 200,
      oldest_unpaid_at: 100,
    });
    await writeAction(db, (w) =>
      w.insert('ledger_entries', entry('l3', 'c1', -6000, 300)),
    );
    expect(await db.party_balances.get(['customer', 'c1'])).toMatchObject({
      balance: 2000,
      oldest_unpaid_at: 200,
      last_activity_at: 300,
    });
  });

  it('rebuilds both caches from movements and ledger entries', async () => {
    const db = freshDb();
    await writeAction(db, async (w) => {
      await w.insert('stock_movements', move('m1', 'p1', 4000));
      await w.insert('stock_movements', move('m2', 'p1', -1000));
      await w.insert('stock_movements', move('m3', 'p2', 2000));
      await w.insert('ledger_entries', entry('l1', 'c1', 5000, 100));
    });
    await db.stock_levels.put({ product_id: 'p1', on_hand_milli: 1 });
    await db.party_balances.clear();
    await rebuildCaches(db);
    expect(await db.stock_levels.get('p1')).toMatchObject({
      on_hand_milli: 3000,
    });
    expect(await db.stock_levels.get('p2')).toMatchObject({
      on_hand_milli: 2000,
    });
    expect(await db.party_balances.get(['customer', 'c1'])).toMatchObject({
      balance: 5000,
      oldest_unpaid_at: 100,
    });
  });

  it('daily check passes on a consistent db and repairs a drifted one', async () => {
    const db = freshDb();
    await writeAction(db, async (w) => {
      await w.create('products', { id: 'p1', name_en: 'X' });
      await w.insert('stock_movements', move('m1', 'p1', 4000));
      await w.insert('ledger_entries', entry('l1', 'c1', 5000, 100));
    });
    expect(await checkCaches(db)).toBe(true);
    await db.stock_levels.put({ product_id: 'p1', on_hand_milli: 9 });
    expect(await checkCaches(db)).toBe(false);
    expect((await db.stock_levels.get('p1'))?.on_hand_milli).toBe(4000);
    await db.party_balances.put({
      party_type: 'customer',
      party_id: 'c1',
      balance: 1,
      last_activity_at: 0,
      oldest_unpaid_at: null,
    });
    expect(await checkCaches(db, 20, () => 0.5)).toBe(false);
    expect((await db.party_balances.get(['customer', 'c1']))?.balance).toBe(
      5000,
    );
  });
});
