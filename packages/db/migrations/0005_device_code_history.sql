-- A device keeps the codes it was enrolled/moved with, so a bill queued before a
-- branch move still matches its invoice (the server accepts any historical code).
ALTER TABLE devices ADD COLUMN device_code_history TEXT NOT NULL DEFAULT '';

-- The operator and the tenant's Sync screen count open conflicts per shop.
CREATE INDEX sync_conflicts_open ON sync_conflicts (tenant_id, resolution);
