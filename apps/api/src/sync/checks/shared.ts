import { rowInGroup } from '../applyOpsShared.ts';
import type { PushOp } from '../opSchema.ts';

/** Server-side checks beyond the database constraints (04 §5, 05 §5). Throws Reject. */
export function sourceInGroup(
  group: PushOp[],
  tbl: string,
  id: string | null,
): Record<string, unknown> | undefined {
  if (id === null) return undefined;
  return rowInGroup(group, tbl, id);
}
