import { describe, expect, it } from 'vitest';
import { READ_ONLY_GRACE_MS, readOnlyEligible } from '../src/routes/sync.ts';
import type { PushOp } from '../src/sync/opSchema.ts';

const tx = (id: string) => id.padEnd(26, '0');
const op = (
  id: string,
  row: Record<string, unknown> | undefined,
  created_at?: number,
): PushOp =>
  row === undefined
    ? {
        op_id: id.padEnd(26, '0'),
        tx_id: tx(`T${id}`),
        tbl: 'products',
        kind: 'delete',
        row_id: 'p1',
        base_rev: 1,
        created_at,
      }
    : {
        op_id: id.padEnd(26, '0'),
        tx_id: tx(`T${id}`),
        tbl: 'products',
        kind: 'upsert',
        row,
        base_rev: 1,
        changed_fields: [],
        created_at,
      };

describe('read-only cutoff', () => {
  const seen = 1_000_000;

  it('uses the op timestamp so a later master edit is not treated as old', () => {
    const oldRow = {
      id: 'p1',
      created_at: seen - 10_000,
      updated_at: seen + 60_000,
    };
    expect(
      readOnlyEligible([op('A', oldRow, seen + READ_ONLY_GRACE_MS + 1)], seen),
    ).toHaveLength(0);
    expect(readOnlyEligible([op('B', oldRow, seen - 1)], seen)).toHaveLength(1);
  });

  it('keeps delete ops only when their op timestamp is inside the grace', () => {
    expect(
      readOnlyEligible(
        [op('C', undefined, seen + READ_ONLY_GRACE_MS - 1)],
        seen,
      ),
    ).toHaveLength(1);
    expect(
      readOnlyEligible(
        [op('D', undefined, seen + READ_ONLY_GRACE_MS + 1)],
        seen,
      ),
    ).toHaveLength(0);
  });

  it('drops a whole transaction when one op is late', () => {
    const early = op('E', { id: 'p1', created_at: seen - 1 }, seen - 1);
    const late = op(
      'F',
      { id: 'p2', created_at: seen + READ_ONLY_GRACE_MS + 1 },
      seen + READ_ONLY_GRACE_MS + 1,
    );
    late.tx_id = early.tx_id;
    expect(readOnlyEligible([early, late], seen)).toHaveLength(0);
  });

  it('falls back to updated_at/created_at for older clients', () => {
    const legacy = op('G', {
      id: 'p1',
      created_at: seen - 10_000,
      updated_at: seen - 1,
    });
    expect(readOnlyEligible([legacy], seen)).toHaveLength(1);
  });
});
