import { oldestUnpaidAt, partyBalance } from '@bikri/core';
import type {
  BikriDb,
  PartyBalance,
  PartyType,
  StockLevel,
  SyncedRow,
} from '@bikri/db';
import type { Table } from 'dexie';

/**
 * Where tables come from: the db, or a Dexie transaction. Writers pass their transaction so
 * every read and write stays in it even after native awaits drop Dexie's zone.
 */
export type TableSource = { table(name: string): Table };

const stockLevels = (src: TableSource) =>
  src.table('stock_levels') as Table<StockLevel, string>;
const partyBalances = (src: TableSource) =>
  src.table('party_balances') as Table<PartyBalance, [PartyType, string]>;
const ledgerEntries = (src: TableSource) =>
  src.table('ledger_entries') as Table<SyncedRow, string>;

/** stock_levels += movement (02 §3.1). Call inside the write transaction. */
export async function applyStockMovement(
  src: TableSource,
  row: SyncedRow,
): Promise<void> {
  const productId = String(row.product_id);
  const delta = Number(row.qty_delta_milli);
  const level = await stockLevels(src).get(productId);
  await stockLevels(src).put({
    product_id: productId,
    on_hand_milli: (level?.on_hand_milli ?? 0) + delta,
  });
}

async function partyEntries(src: TableSource, type: PartyType, id: string) {
  return ledgerEntries(src)
    .where('[party_type+party_id+created_at]')
    .between([type, id, -Infinity], [type, id, Infinity])
    .toArray();
}

function balanceOf(
  type: PartyType,
  id: string,
  entries: readonly SyncedRow[],
): PartyBalance {
  const amounts = entries.map((e) => ({
    amount: Number(e.amount),
    created_at: Number(e.created_at),
  }));
  return {
    party_type: type,
    party_id: id,
    balance: partyBalance(amounts.map((a) => a.amount)),
    last_activity_at: amounts.reduce((m, a) => Math.max(m, a.created_at), 0),
    oldest_unpaid_at: oldestUnpaidAt(amounts),
  };
}

/** Recomputes one party's balance row after a ledger entry was written. */
export async function applyLedgerEntry(
  src: TableSource,
  row: SyncedRow,
): Promise<void> {
  const type = row.party_type as PartyType;
  const id = String(row.party_id);
  await partyBalances(src).put(
    balanceOf(type, id, await partyEntries(src, type, id)),
  );
}

/** 02 §3.2: clear both caches and recompute them from movements and ledger entries. */
export async function rebuildCaches(db: BikriDb): Promise<void> {
  await db.transaction(
    'rw',
    [db.stock_levels, db.party_balances, db.stock_movements, db.ledger_entries],
    async () => {
      await db.stock_levels.clear();
      await db.party_balances.clear();
      const stock = new Map<string, number>();
      await db.stock_movements.each((m) => {
        const id = String(m.product_id);
        stock.set(id, (stock.get(id) ?? 0) + Number(m.qty_delta_milli));
      });
      await db.stock_levels.bulkPut(
        [...stock].map(([product_id, on_hand_milli]) => ({
          product_id,
          on_hand_milli,
        })),
      );
      const parties = new Map<string, SyncedRow[]>();
      await db.ledger_entries.each((e) => {
        const key = `${String(e.party_type)}\u0000${String(e.party_id)}`;
        const list = parties.get(key) ?? [];
        list.push(e);
        parties.set(key, list);
      });
      await db.party_balances.bulkPut(
        [...parties].map(([key, entries]) => {
          const [type, id] = key.split('\u0000') as [PartyType, string];
          return balanceOf(type, id, entries);
        }),
      );
    },
  );
}

/**
 * Daily consistency check (02 §3.2): recompute up to `sample` random products and parties.
 * Returns true when every sampled cache row matched; otherwise rebuilds and returns false.
 */
export async function checkCaches(
  db: BikriDb,
  sample = 20,
  random: () => number = Math.random,
): Promise<boolean> {
  const pick = <T>(list: T[]): T[] => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy.slice(0, sample);
  };
  let ok = true;
  const products = pick(
    (await db.products.toCollection().primaryKeys()) as string[],
  );
  for (const id of products) {
    const moves = await db.stock_movements
      .where('[product_id+created_at]')
      .between([id, -Infinity], [id, Infinity])
      .toArray();
    const expected = moves.reduce((s, m) => s + Number(m.qty_delta_milli), 0);
    const cached = (await db.stock_levels.get(id))?.on_hand_milli ?? 0;
    if (cached !== expected) ok = false;
  }
  const parties = pick(await db.party_balances.toArray());
  for (const p of parties) {
    const expected = balanceOf(
      p.party_type,
      p.party_id,
      await partyEntries(db, p.party_type, p.party_id),
    );
    if (
      expected.balance !== p.balance ||
      expected.oldest_unpaid_at !== p.oldest_unpaid_at
    )
      ok = false;
  }
  if (!ok) await rebuildCaches(db);
  return ok;
}
