import type { SyncedRow } from '@bikri/db';
import { describe, expect, it } from 'vitest';
import { pickRefundChoices } from './RefundDialog.tsx';

const line = (
  id: string,
  keptMilli: number,
  extra: Record<string, unknown> = {},
): { line: SyncedRow; keptMilli: number } => ({
  line: { id, qty_milli: keptMilli, ...extra } as SyncedRow,
  keptMilli,
});

describe('refund row selection (UI-H3)', () => {
  const lines = [line('l1', 1000), line('l2', 2000)];

  it('keeps a checked row selected while its qty draft is empty', () => {
    // The cashier checked both rows, then cleared row l1's QtyInput: the draft is
    // null but the row must not be unchecked (and its input stays mounted).
    expect(
      pickRefundChoices(
        lines,
        'items',
        { l1: true, l2: true },
        { l1: null, l2: 500 },
        {},
      ),
    ).toEqual([{ saleLineId: 'l2', qtyMilli: 500, restock: true }]);
    // Typing a quantity again restores the row without re-checking it.
    expect(
      pickRefundChoices(
        lines,
        'items',
        { l1: true, l2: true },
        { l1: 750, l2: 500 },
        {},
      ),
    ).toEqual([
      { saleLineId: 'l1', qtyMilli: 750, restock: true },
      { saleLineId: 'l2', qtyMilli: 500, restock: true },
    ]);
  });

  it('ignores an unchecked row and clamps a draft to what is left', () => {
    expect(
      pickRefundChoices(
        lines,
        'items',
        { l1: true },
        { l1: 5000, l2: 500 },
        {},
      ),
    ).toEqual([{ saleLineId: 'l1', qtyMilli: 1000, restock: true }]);
  });

  it('selects every remaining line in whole mode', () => {
    expect(pickRefundChoices(lines, 'whole', {}, {}, {})).toEqual([
      { saleLineId: 'l1', qtyMilli: 1000, restock: true },
      { saleLineId: 'l2', qtyMilli: 2000, restock: true },
    ]);
  });

  it('returns whole bundles only and keeps the group restock choice', () => {
    const bundle = [
      line('c1', 6000, {
        bundle_id: 'b1',
        bundle_group: 'g1',
        bundle_component_qty_milli: 1000,
      }),
      line('c2', 6000, {
        bundle_id: 'b1',
        bundle_group: 'g1',
        bundle_component_qty_milli: 1000,
      }),
    ];
    // Checked but cleared: nothing to refund yet, and no partial component line.
    expect(
      pickRefundChoices(bundle, 'items', { g1: true }, { g1: null }, {}),
    ).toEqual([]);
    expect(
      pickRefundChoices(
        bundle,
        'items',
        { g1: true },
        { g1: 2000 },
        { g1: false },
      ),
    ).toEqual([
      { saleLineId: 'c1', qtyMilli: 2000, restock: false },
      { saleLineId: 'c2', qtyMilli: 2000, restock: false },
    ]);
  });
});
