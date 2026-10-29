import { z } from 'zod';

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
/** Not every row id is a ULID: 'shop', system expense category codes (04 §4). */
const RowId = z.union([
  Ulid,
  z.literal('shop'),
  z.string().regex(/^[a-z_]{2,30}$/u),
]);

/**
 * Ops are checked structurally here; the table, kind and row are checked per op so one bad op
 * is `rejected` (UNKNOWN_TABLE, IMMUTABLE_TABLE, …) instead of failing the batch (03 §4.1).
 */
export const PushOpSchema = z.object({
  op_id: Ulid,
  tx_id: Ulid,
  tbl: z.string().max(40),
  kind: z.enum(['insert', 'upsert', 'delete']),
  row: z.record(z.string(), z.unknown()).optional(),
  row_id: RowId.optional(),
  base_rev: z.number().int().min(0).optional(),
  changed_fields: z.array(z.string().max(40)).max(80).optional(),
  /** Delete ops carry the staff who deleted (permission check, D-104). */
  updated_by: z.string().max(40).nullable().optional(),
  /** When the till queued the op; used for the read-only cutoff (13 §7.2). */
  created_at: z.number().int().optional(),
});
export type PushOp = z.infer<typeof PushOpSchema>;

export const PushBody = z.object({
  device_id: Ulid,
  schema_version: z.number().int(),
  app_version: z.string().max(20),
  ops: z.array(PushOpSchema).min(1).max(200),
});

export const ImportOpsBody = z.object({
  device_id: Ulid,
  ops: z.array(PushOpSchema).min(1).max(200),
});

export const PullQuery = z.object({
  since: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export type OpResult = {
  op_id: string;
  result: 'applied' | 'conflict_merged' | 'rejected';
  error_code?: string;
  server_rev?: number;
};
