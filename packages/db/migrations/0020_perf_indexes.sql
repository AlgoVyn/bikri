-- D-231: indexes for the fourth whole-app performance review. Additive only;
-- SCHEMA_VERSION is unchanged (the previous review migrations did the same).
--
-- Refund/void planning reads the sale movements of the bills in the transaction.
-- Without a ref_id index SQLite can only use the tenant_id prefix, so one refund
-- scanned every stock movement the shop had ever written.
CREATE INDEX stock_movements_ref
  ON stock_movements (tenant_id, ref_id, reason_code, product_id)
  WHERE ref_id IS NOT NULL;

-- A purchase document carries its paid-now payment; the lookup by purchase_id had
-- only the tenant prefix and scanned all payments.
CREATE INDEX payments_purchase
  ON payments (tenant_id, purchase_id)
  WHERE purchase_id IS NOT NULL;

-- Device-code allocation on enrolment/branch move reads the branch's invoice
-- numbers; a year-old shop scanned all its sales and built a DISTINCT temp tree.
CREATE INDEX sales_branch_invoice
  ON sales (tenant_id, branch_id, invoice_no);

-- The operator tenant page reads the last status changes; the partial index keeps
-- this index tiny while avoiding a backwards scan over the whole audit log.
CREATE INDEX audit_log_status
  ON audit_log (tenant_id, created_at)
  WHERE action = 'tenant_status_change';
