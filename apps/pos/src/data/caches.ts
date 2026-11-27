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

/**
 * Applies a page of movements with two requests per product instead of two per row.
 * Pull/snapshot pages are up to 500 rows; a sale page can contain many movements for
 * the same product, and the old loop held the writer transaction open for each one.
 */
export async function applyStockMovements(
  src: TableSource,
  rows: readonly SyncedRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const deltas = new Map<string, number>();
  for (const row of rows) {
    const productId = String(row.product_id);
    deltas.set(
      productId,
      (deltas.get(productId) ?? 0) + Number(row.qty_delta_milli),
    );
  }
  const ids = [...deltas.keys()];
  const levels = await stockLevels(src).bulkGet(ids);
  await stockLevels(src).bulkPut(
    ids.map((productId, index) => ({
      product_id: productId,
      on_hand_milli:
        (levels[index]?.on_hand_milli ?? 0) + (deltas.get(productId) ?? 0),
    })),
  );
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
  lastDeliveryDate?: string | null,
): PartyBalance {
  const amounts = entries.map((e) => ({
    amount: Number(e.amount),
    created_at: Number(e.created_at),
  }));
  const lastPayment = entries.reduce(
    (max, entry) =>
      entry.source_type === 'payment'
        ? Math.max(max, Number(entry.created_at))
        : max,
    0,
  );
  return {
    party_type: type,
    party_id: id,
    balance: partyBalance(amounts.map((a) => a.amount)),
    last_activity_at: amounts.reduce((m, a) => Math.max(m, a.created_at), 0),
    oldest_unpaid_at: oldestUnpaidAt(amounts),
    last_payment_at: lastPayment > 0 ? lastPayment : null,
    ...(lastDeliveryDate ? { last_delivery_date: lastDeliveryDate } : {}),
  };
}

/**
 * Updates the supplier last-delivery cache (Dexie V18) from freshly stored purchases.
 * A delivery does not always write a ledger row (a free delivery writes none), so the
 * party cache row may not exist yet; create a zero-balance row in that case. Only a later
 * business date replaces the stored one, so pulled pages in any order converge.
 */
export async function applyPurchaseDates(
  src: TableSource,
  rows: readonly SyncedRow[],
): Promise<void> {
  const latest = new Map<string, string>();
  for (const row of rows) {
    const supplierId = String(row.supplier_id ?? '');
    const date = String(row.business_date ?? '');
    if (supplierId === '' || date === '') continue;
    if (date > (latest.get(supplierId) ?? '')) latest.set(supplierId, date);
  }
  if (latest.size === 0) return;
  const ids = [...latest.keys()];
  const current = await partyBalances(src).bulkGet(
    ids.map((id) => ['supplier', id] as [PartyType, string]),
  );
  const changed: PartyBalance[] = [];
  ids.forEach((id, index) => {
    const date = latest.get(id) as string;
    const existing = current[index];
    if (existing === undefined) {
      changed.push({
        party_type: 'supplier',
        party_id: id,
        balance: 0,
        last_activity_at: 0,
        oldest_unpaid_at: null,
        last_payment_at: null,
        last_delivery_date: date,
      });
      return;
    }
    if ((existing.last_delivery_date ?? '') < date)
      changed.push({ ...existing, last_delivery_date: date });
  });
  if (changed.length > 0) await partyBalances(src).bulkPut(changed);
}

/** Preserve the supplier delivery cache field when a balance row is rebuilt. */
function withDeliveryDate(
  row: PartyBalance,
  existing: PartyBalance | undefined,
): PartyBalance {
  const date = existing?.last_delivery_date;
  return date ? { ...row, last_delivery_date: date } : row;
}

/**
 * Recomputes one party's balance row after a ledger entry was written.
 *
 * A new debit (a credit sale, opening balance, purchase) appends in time order on a sale
 * write: the previous balance only grows and the oldest open debit cannot move earlier,
 * so the cache can be updated without reading the party's whole history. Credits (and
 * out-of-order rows from a pull/restore) still take the exact full scan.
 */
export async function applyLedgerEntry(
  src: TableSource,
  row: SyncedRow,
): Promise<void> {
  const type = row.party_type as PartyType;
  const id = String(row.party_id);
  const amount = Number(row.amount);
  const at = Number(row.created_at);
  const current = await partyBalances(src).get([type, id]);
  if (
    amount > 0 &&
    (current === undefined ||
      (Number.isFinite(at) && at >= Number(current.last_activity_at)))
  ) {
    const balance = (current?.balance ?? 0) + amount;
    await partyBalances(src).put(
      withDeliveryDate(
        {
          party_type: type,
          party_id: id,
          balance,
          last_activity_at: Math.max(current?.last_activity_at ?? 0, at),
          oldest_unpaid_at:
            balance > 0 ? (current?.oldest_unpaid_at ?? at) : null,
          last_payment_at:
            row.source_type === 'payment'
              ? Math.max(Number(current?.last_payment_at ?? 0), at)
              : (current?.last_payment_at ?? null),
        },
        current,
      ),
    );
    return;
  }
  // A credit that clears the account leaves no open debit, so the exact
  // oldest-unpaid date is null and the party's whole history does not need a
  // rescan. A partial credit still takes the exact path below (a payment can
  // clear the oldest debit and part of the next).
  if (amount < 0 && current !== undefined && current.balance + amount <= 0) {
    await partyBalances(src).put(
      withDeliveryDate(
        {
          party_type: type,
          party_id: id,
          balance: current.balance + amount,
          last_activity_at: Math.max(current.last_activity_at, at),
          oldest_unpaid_at: null,
          last_payment_at:
            row.source_type === 'payment'
              ? Math.max(Number(current.last_payment_at ?? 0), at)
              : (current.last_payment_at ?? null),
        },
        current,
      ),
    );
    return;
  }
  await partyBalances(src).put(
    balanceOf(
      type,
      id,
      await partyEntries(src, type, id),
      current?.last_delivery_date,
    ),
  );
}

/** Recompute one party's cache row from every stored entry (after a multi-row batch). */
export async function recomputePartyBalance(
  src: TableSource,
  row: SyncedRow,
): Promise<void> {
  const type = row.party_type as PartyType;
  const id = String(row.party_id);
  const current = await partyBalances(src).get([type, id]);
  await partyBalances(src).put(
    balanceOf(
      type,
      id,
      await partyEntries(src, type, id),
      current?.last_delivery_date,
    ),
  );
}

/**
 * Applies a batch of freshly stored ledger rows. A party with one fresh row can use the
 * incremental path; with two or more the incremental path would count a later sibling
 * twice (the first slow path already summed the whole stored batch), so recompute that
 * party once instead.
 */
export async function applyLedgerEntries(
  src: TableSource,
  rows: readonly SyncedRow[],
): Promise<void> {
  const byParty = new Map<string, SyncedRow[]>();
  for (const row of rows) {
    const key = `${String(row.party_type)}\u0000${String(row.party_id)}`;
    const group = byParty.get(key);
    if (group) group.push(row);
    else byParty.set(key, [row]);
  }
  for (const group of byParty.values()) {
    const first = group[0];
    if (!first) continue;
    if (group.length === 1) await applyLedgerEntry(src, first);
    else await recomputePartyBalance(src, first);
  }
}

/** 02 §3.2: clear both caches and recompute them from movements and ledger entries. */
export async function rebuildCaches(db: BikriDb): Promise<void> {
  // Two transactions, not one over four stores: the stock cache and the party cache
  // are independent and a large restore should not block both sets of live queries
  // for the whole rebuild. The party pass keeps one party's entries, not every row.
  await db.transaction(
    'rw',
    [db.stock_levels, db.stock_movements],
    async () => {
      await db.stock_levels.clear();
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
    },
  );
  // Let live queries and a sale written during a restore run between the two passes.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await db.transaction(
    'rw',
    [db.party_balances, db.ledger_entries, db.purchases],
    async () => {
      // Supplier last-delivery dates live on the party cache (V18); rebuild them from
      // purchases rather than scanning that table on every supplier-list open.
      const deliveries = new Map<string, string>();
      await db.purchases.each((purchase) => {
        const supplierId = String(purchase.supplier_id ?? '');
        const date = String(purchase.business_date ?? '');
        if (supplierId === '' || date === '') return;
        if (date > (deliveries.get(supplierId) ?? ''))
          deliveries.set(supplierId, date);
      });
      await db.party_balances.clear();
      // The index is ordered by party then time, so a party's entries are contiguous.
      // Flush one party at a time instead of retaining every ledger row in a Map.
      const balances: PartyBalance[] = [];
      let currentType: PartyType | null = null;
      let currentId = '';
      let current: SyncedRow[] = [];
      const flush = () => {
        if (currentType !== null && current.length > 0)
          balances.push(
            balanceOf(
              currentType,
              currentId,
              current,
              currentType === 'supplier'
                ? deliveries.get(currentId)
                : undefined,
            ),
          );
      };
      await db.ledger_entries
        .orderBy('[party_type+party_id+created_at]')
        .each((entry) => {
          const type = entry.party_type as PartyType;
          const id = String(entry.party_id);
          if (type !== currentType || id !== currentId) {
            flush();
            currentType = type;
            currentId = id;
            current = [];
          }
          current.push(entry);
        });
      flush();
      // A supplier with only free deliveries has no ledger row; keep its date visible.
      const seen = new Set(
        balances
          .filter((row) => row.party_type === 'supplier')
          .map((row) => row.party_id),
      );
      for (const [supplierId, date] of deliveries) {
        if (seen.has(supplierId)) continue;
        balances.push({
          party_type: 'supplier',
          party_id: supplierId,
          balance: 0,
          last_activity_at: 0,
          oldest_unpaid_at: null,
          last_payment_at: null,
          last_delivery_date: date,
        });
      }
      await db.party_balances.bulkPut(balances);
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
  // One read transaction over both caches and their sources. Separate reads let a
  // sale commit between them, which looked like a cache mismatch and forced a full
  // 440k-row rebuild.
  const mismatches = await db.transaction(
    'r',
    [
      db.products,
      db.stock_movements,
      db.stock_levels,
      db.party_balances,
      db.ledger_entries,
    ],
    async () => {
      const stock: boolean[] = [];
      const products = pick(
        (await db.products.toCollection().primaryKeys()) as string[],
      );
      for (const id of products) {
        const moves = await db.stock_movements
          .where('[product_id+created_at]')
          .between([id, -Infinity], [id, Infinity])
          .toArray();
        const expected = moves.reduce(
          (sum, move) => sum + Number(move.qty_delta_milli),
          0,
        );
        const cached = (await db.stock_levels.get(id))?.on_hand_milli ?? 0;
        stock.push(cached === expected);
      }
      const parties: boolean[] = [];
      const partyKeys = pick(
        await db.party_balances.toCollection().primaryKeys(),
      );
      const partyRows = await db.party_balances.bulkGet(partyKeys);
      for (const p of partyRows) {
        if (!p) continue;
        const expected = balanceOf(
          p.party_type,
          p.party_id,
          await partyEntries(db, p.party_type, p.party_id),
        );
        parties.push(
          expected.balance === p.balance &&
            expected.oldest_unpaid_at === p.oldest_unpaid_at,
        );
      }
      return [...stock, ...parties];
    },
  );
  const ok = mismatches.every(Boolean);
  if (!ok) await rebuildCaches(db);
  return ok;
}
