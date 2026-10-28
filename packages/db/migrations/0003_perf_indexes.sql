-- T-062: indexes for the refund/reversal/lookup hot paths. Additive only.
CREATE INDEX payments_refund ON payments (tenant_id, refund_id) WHERE refund_id IS NOT NULL;
CREATE INDEX payments_supplier_return ON payments (tenant_id, supplier_return_id) WHERE supplier_return_id IS NOT NULL;
CREATE INDEX expenses_reversal ON expenses (tenant_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX ledger_source ON ledger_entries (tenant_id, source_type, source_id) WHERE source_id IS NOT NULL;
