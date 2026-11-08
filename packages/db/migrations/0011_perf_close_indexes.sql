-- T-062 follow-up: selective indexes for the day-close push. Additive only.
--
-- applyOps reads the payments, cash moves and expenses of each closing device between
-- period_start and period_end. Without these indexes SQLite scans every row the tenant
-- has ever written for those tables (only the tenant_id prefix is usable), which grows
-- with the shop's age and burns the D1 rows-read budget on every close.
CREATE INDEX payments_device_created ON payments (tenant_id, device_id, created_at);
CREATE INDEX expenses_device_created ON expenses (tenant_id, device_id, created_at);
CREATE INDEX cash_moves_device_created ON cash_moves (tenant_id, device_id, created_at);
