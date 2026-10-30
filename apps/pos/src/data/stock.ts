/**
 * Stock adjust and stock count (screens/09, T-021). Writes `stock_movements` only (append-only,
 * REQ-C03); costed stock-in also moves the provisional avg / last cost (07 §7).
 */
import { businessDate, newId, nextAvgCost } from '@bikri/core';
import type { BikriDb, MasterRow } from '@bikri/db';
import type { LedgerContext } from './products.ts';
import { type Writer, writeAction } from './write.ts';

export type AdjustKind = 'in' | 'out' | 'count' | 'fix';
export const IN_REASONS = [
  'received_godown',
  'received_local',
  'customer_return',
  'received_other',
] as const;
export const OUT_REASONS = [
  'damaged',
  'expired',
  'lost',
  'spoiled',
  'wrong_item',
] as const;
export type AdjustReason =
  | (typeof IN_REASONS)[number]
  | (typeof OUT_REASONS)[number]
  | 'count'
  | 'entry_fix';
const COSTED = new Set(['received_godown', 'received_local', 'received_other']);
const NOTE_REQUIRED = new Set(['received_other', 'lost', 'entry_fix']);
export const NOTE_MAX = 120;

export const needsCost = (reason: string) => COSTED.has(reason);
export const needsNote = (reason: string) => NOTE_REQUIRED.has(reason);

export class StockAdjustError extends Error {
  readonly field: 'qty' | 'cost' | 'note' | 'product';
  constructor(field: StockAdjustError['field']) {
    super(`invalid ${field}`);
    this.name = 'StockAdjustError';
    this.field = field;
  }
}

export type AdjustInput = {
  productId: string;
  kind: AdjustKind;
  /** in/out: the reason; count → `count`; fix → `entry_fix`. */
  reason?: AdjustReason;
  /** in/out: quantity > 0; count: counted quantity ≥ 0; fix: signed change ≠ 0. */
  qtyMilli: number;
  unitCost?: number | null;
  note?: string;
};

/** On hand from the stock_levels cache; inside an action pass the Writer (its table is in the tx). */
export async function onHand(
  db: BikriDb | Writer,
  productId: string,
): Promise<number> {
  const table = (db as Writer).table<
    { product_id: string; on_hand_milli: number },
    string
  >('stock_levels');
  return (await table.get(productId))?.on_hand_milli ?? 0;
}

/** Signed delta an adjustment would write (for the live "New on hand"). */
export function adjustDelta(
  kind: AdjustKind,
  qtyMilli: number,
  current: number,
): number {
  if (kind === 'in') return qtyMilli;
  if (kind === 'out') return -qtyMilli;
  if (kind === 'count') return qtyMilli - current;
  return qtyMilli;
}

function reasonFor(input: AdjustInput): AdjustReason {
  if (input.kind === 'count') return 'count';
  if (input.kind === 'fix') return 'entry_fix';
  const list: readonly string[] =
    input.kind === 'in' ? IN_REASONS : OUT_REASONS;
  if (!input.reason || !list.includes(input.reason))
    throw new StockAdjustError('qty');
  return input.reason;
}

async function insertMovement(
  w: Writer,
  product: MasterRow,
  delta: number,
  reason: string,
  ctx: LedgerContext,
  extra: { unitCost: number | null; note: string },
) {
  return w.insert('stock_movements', {
    id: newId(w.now),
    product_id: product.id,
    qty_delta_milli: delta,
    reason_code: reason,
    ref_type: 'adjustment',
    ref_id: null,
    unit_cost: extra.unitCost,
    note: extra.note,
    branch_id: ctx.branch_id,
    device_id: ctx.device_id,
    staff_id: ctx.staff_id,
    business_date: businessDate(w.now, ctx.timeZone),
    created_at: w.now,
  });
}

/**
 * One adjustment. `count` uses the on-hand at the moment of saving; a count equal to on hand
 * writes nothing and returns null.
 */
export async function adjustStock(
  db: BikriDb,
  input: AdjustInput,
  ctx: LedgerContext,
  now = Date.now(),
) {
  const reason = reasonFor(input);
  const note = (input.note ?? '').trim();
  if (!Number.isSafeInteger(input.qtyMilli)) throw new StockAdjustError('qty');
  if ((input.kind === 'in' || input.kind === 'out') && input.qtyMilli <= 0)
    throw new StockAdjustError('qty');
  if (input.kind === 'count' && input.qtyMilli < 0)
    throw new StockAdjustError('qty');
  if (input.kind === 'fix' && input.qtyMilli === 0)
    throw new StockAdjustError('qty');
  if (needsNote(reason) && !note) throw new StockAdjustError('note');
  if (note.length > NOTE_MAX) throw new StockAdjustError('note');
  const costed = needsCost(reason);
  const unitCost = costed ? input.unitCost : null;
  if (
    costed &&
    (unitCost == null || !Number.isSafeInteger(unitCost) || unitCost < 0)
  )
    throw new StockAdjustError('cost');
  return writeAction(
    db,
    async (w) => {
      const product = await w
        .table<MasterRow, string>('products')
        .get(input.productId);
      if (!product || product.deleted_at || product.track_stock !== 1)
        throw new StockAdjustError('product');
      const current = await onHand(w, product.id);
      const delta = adjustDelta(input.kind, input.qtyMilli, current);
      if (delta === 0) return null;
      if (costed && unitCost != null) {
        const avg = nextAvgCost({
          on_hand_milli: current,
          avg_cost: Number(product.avg_cost ?? 0),
          qty_milli: delta,
          unit_cost: unitCost,
        });
        await w.update('products', product.id, {
          avg_cost: avg,
          last_cost: unitCost,
        });
      }
      return insertMovement(w, product, delta, reason, ctx, {
        unitCost: unitCost ?? null,
        note,
      });
    },
    { now, actor: ctx.staff_id },
  );
}

// --- stock count (screens/09) ---

export type CountScope =
  | { kind: 'all' }
  | { kind: 'category'; categoryId: string }
  | { kind: 'low' };

export type CountDraft = {
  scope: CountScope;
  started_at: number;
  /** product id → on hand when the count started (display only). */
  expected: Record<string, number>;
  /** product id → counted milli. */
  counted: Record<string, number>;
  /** Products whose chunk already committed; a retry must not apply them again. */
  applied?: string[];
};

export const DRAFT_KEY = 'stock_count_draft';

export async function countProducts(
  db: BikriDb,
  scope: CountScope,
): Promise<MasterRow[]> {
  const levels = new Map(
    (await db.stock_levels.toArray()).map((l) => [
      l.product_id,
      l.on_hand_milli,
    ]),
  );
  const list = (await db.products.toArray()).filter((p) => {
    if (p.deleted_at || p.track_stock !== 1) return false;
    if (scope.kind === 'category') return p.category_id === scope.categoryId;
    if (scope.kind === 'low') {
      const min = Number(p.min_stock_milli ?? 0);
      return min > 0 && (levels.get(p.id) ?? 0) <= min;
    }
    return true;
  });
  return list.sort((a, b) =>
    String(a.name_en).localeCompare(String(b.name_en)),
  );
}

export async function startCount(
  db: BikriDb,
  scope: CountScope,
  now = Date.now(),
): Promise<CountDraft> {
  const products = await countProducts(db, scope);
  const expected: Record<string, number> = {};
  for (const p of products) expected[p.id] = await onHand(db, p.id);
  const draft: CountDraft = {
    scope,
    started_at: now,
    expected,
    counted: {},
    applied: [],
  };
  await db.kv.put({ key: DRAFT_KEY, value: draft });
  return draft;
}

export async function loadCountDraft(db: BikriDb): Promise<CountDraft | null> {
  return ((await db.kv.get(DRAFT_KEY))?.value ?? null) as CountDraft | null;
}

export async function saveCountDraft(
  db: BikriDb,
  draft: CountDraft,
): Promise<void> {
  await db.kv.put({ key: DRAFT_KEY, value: draft });
}

let draftChain: Promise<unknown> = Promise.resolve();

/**
 * Serialised read-modify-write of one product's count on the stored draft, so fast scans
 * never lose a +1 (each change reads the latest draft, not a rendered copy).
 */
export function updateCount(
  db: BikriDb,
  productId: string,
  next: (current: number | undefined) => number | null,
): Promise<CountDraft | null> {
  const run = draftChain.then(async () => {
    const draft = await loadCountDraft(db);
    if (!draft) return null;
    const counted = { ...draft.counted };
    const value = next(counted[productId]);
    if (value === null) delete counted[productId];
    else counted[productId] = value;
    const updated = { ...draft, counted };
    await saveCountDraft(db, updated);
    return updated;
  });
  draftChain = run.catch(() => undefined);
  return run;
}

export async function discardCount(db: BikriDb): Promise<void> {
  await db.kv.delete(DRAFT_KEY);
}

export type CountResult = {
  movements: number;
  counted: number;
  valueDiff: number;
};

/**
 * Finish count: one `count` movement per product whose counted quantity differs from the
 * on-hand **now**; uncounted products are skipped unless `zeroUncounted`. Work is split into
 * chunks so a count of hundreds of products stays below the 200-op action limit. The draft is
 * cleared only after every chunk succeeds; retrying a partially applied count is safe because
 * the remaining deltas are zero.
 */
export async function finishCount(
  db: BikriDb,
  draft: CountDraft,
  options: { zeroUncounted: boolean },
  ctx: LedgerContext,
  now = Date.now(),
): Promise<CountResult> {
  const stored = await loadCountDraft(db);
  const source = {
    ...draft,
    expected: { ...draft.expected, ...(stored?.expected ?? {}) },
    counted: { ...draft.counted, ...(stored?.counted ?? {}) },
    applied: [
      ...new Set([...(draft.applied ?? []), ...(stored?.applied ?? [])]),
    ],
  };
  const applied = new Set(source.applied);
  const ids = Object.keys(source.expected).filter((id) => !applied.has(id));
  const result: CountResult = { movements: 0, counted: 0, valueDiff: 0 };
  const chunkSize = 90;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const slice = ids.slice(offset, offset + chunkSize);
    const part = await writeAction(
      db,
      async (w) => {
        let movements = 0;
        let counted = 0;
        let valueDiff = 0;
        for (const id of slice) {
          const has = Object.hasOwn(source.counted, id);
          if (!has && !options.zeroUncounted) continue;
          const qty = has ? (source.counted[id] ?? 0) : 0;
          if (has) counted += 1;
          const product = await w.table<MasterRow, string>('products').get(id);
          if (!product || product.deleted_at || product.track_stock !== 1)
            continue;
          const delta = qty - (await onHand(w, id));
          if (delta === 0) continue;
          await insertMovement(w, product, delta, 'count', ctx, {
            unitCost: null,
            note: '',
          });
          movements += 1;
          valueDiff += Math.round(
            (delta * Number(product.avg_cost ?? 0)) / 1000,
          );
        }
        await w.insert('audit_log', {
          id: newId(w.now),
          action: 'stock_count',
          entity: 'stock',
          entity_id: ctx.device_id,
          before_json: null,
          after_json: JSON.stringify({
            scope: source.scope,
            items_counted: counted,
            movements,
            value_diff: valueDiff,
          }),
          device_id: ctx.device_id,
          staff_id: ctx.staff_id,
          created_at: now,
        });
        return { movements, counted, valueDiff };
      },
      { now },
    );
    result.movements += part.movements;
    result.counted += part.counted;
    result.valueDiff += part.valueDiff;
    for (const id of slice) applied.add(id);
    await saveCountDraft(db, { ...source, applied: [...applied] });
  }
  await discardCount(db);
  return result;
}
