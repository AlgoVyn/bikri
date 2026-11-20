-- D-231 / fifth performance review P0: index the self-reference used by restore purge
-- and tenant deletion.
--
-- `sales.replaces_sale_id` references `sales(tenant_id, id)`. Both the operator purge
-- and the nightly tenant delete remove replacement bills first, so SQLite must check
-- for children on every deleted row. Without an index on the child column that check
-- scans every bill in the tenant: deleting 2,000 of 20,000 bills measured 4-14 s.
--
-- The index is partial because `replaces_sale_id` is NULL on virtually every bill, so
-- normal sales write no index entry. Additive only; SCHEMA_VERSION is unchanged.
CREATE INDEX sales_replaces
  ON sales (tenant_id, replaces_sale_id)
  WHERE replaces_sale_id IS NOT NULL;
