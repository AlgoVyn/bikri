-- D-315: one idempotency receipt per outbox transaction instead of one per op.
-- Server-only: no client wire change. `applied_ops` stays read-only for pre-deploy
-- receipts until its 90-day retention has elapsed.
CREATE TABLE applied_tx (
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  tx_id        TEXT NOT NULL,              -- ULID from the till outbox (one user action)
  device_id    TEXT NOT NULL,
  applied_at   INTEGER NOT NULL,
  result       TEXT NOT NULL CHECK (result IN ('applied','rejected')),
  results_json TEXT NOT NULL,              -- [{ op_id, result, server_rev?, error_code? }, …]
  PRIMARY KEY (tenant_id, tx_id)
) STRICT;
CREATE INDEX applied_tx_at ON applied_tx (applied_at);
