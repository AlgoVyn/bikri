-- bikri:allow-destructive
-- D-317: applied_tx has been the only idempotency receipt since v1.2.3. The
-- owner confirmed no pre-v1.2.3 transaction remains to replay, and production
-- had no legacy row newer than 2026-11-26 15:34 UTC (37 hours before the v1.2.3
-- deploy). v1.2.4 stopped reading and writing this table.
DROP TABLE applied_ops;
