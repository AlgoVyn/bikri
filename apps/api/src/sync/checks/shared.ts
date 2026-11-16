import type { PushOp } from '../opSchema.ts';

/** Server-side checks beyond the database constraints (04 §5, 05 §5). Throws Reject. */
export function sourceInGroup(
  group: PushOp[],
  tbl: string,
  id: string | null,
): Record<string, unknown> | undefined {
  if (id === null) return undefined;
  return group.find(
    (o) => o.tbl === tbl && o.kind === 'insert' && o.row?.id === id,
  )?.row;
}
