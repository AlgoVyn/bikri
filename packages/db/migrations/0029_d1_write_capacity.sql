-- D-278: D1 write/read capacity from the fifth performance review. Additive and
-- index-only at the data level: no tenant column, wire shape or API changes.

-- Four indexes no server query uses; every one cost D1 writes per row.
DROP INDEX IF EXISTS products_kind;
DROP INDEX IF EXISTS purchases_supplier;
DROP INDEX IF EXISTS supplier_returns_supplier;
DROP INDEX IF EXISTS audit_log_time;

-- Only refund ledger rows are looked up by source; the old index covered ~all rows.
DROP INDEX IF EXISTS ledger_source;
CREATE INDEX ledger_source
  ON ledger_entries (tenant_id, source_id)
  WHERE source_type = 'refund' AND source_id IS NOT NULL;

-- Only void-reversal payments are looked up by sale; sale/refund payments use
-- refund_id, purchase_id or supplier_return_id.
DROP INDEX IF EXISTS payments_sale;
CREATE INDEX payments_sale
  ON payments (tenant_id, sale_id)
  WHERE purpose = 'void' AND sale_id IS NOT NULL;

-- The refund/void planning query reads exactly these four columns for sale rows.
DROP INDEX IF EXISTS stock_movements_ref;
CREATE INDEX stock_movements_ref
  ON stock_movements (tenant_id, ref_id, product_id, qty_delta_milli)
  WHERE reason_code = 'sale' AND ref_id IS NOT NULL;

-- Party balances only sum the amount; created_at made the index wider for nothing.
DROP INDEX IF EXISTS ledger_party;
CREATE INDEX ledger_party
  ON ledger_entries (tenant_id, party_type, party_id, amount);

-- The nightly prune no longer needs a per-row (tenant_id, at, seq) index: a daily
-- watermark gives it the seq ceiling for the 30-day cutoff in one tiny read.
DROP INDEX IF EXISTS change_log_prune;
CREATE TABLE change_log_watermarks (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  day       TEXT NOT NULL,
  max_seq   INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, day)
) STRICT;
