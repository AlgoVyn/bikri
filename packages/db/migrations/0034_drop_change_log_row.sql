-- D-302 / 24 Nov review M5 (safe first step): `change_log_row` has no production
-- reader. Pull reads by `(tenant_id, seq)`, the prune uses the daily watermark/seq,
-- and the only `tbl,row_id` lookups are in tests. Dropping it removes one index write
-- from every synced row. The batch-level `applied_ops` redesign remains separate.
DROP INDEX IF EXISTS change_log_row;
