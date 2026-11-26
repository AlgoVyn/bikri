-- 0036_quotations.sql
--
-- Quotations are a separate, non-financial sales document. They are ordinary
-- master rows (editable while open, soft-deleted only as a status), never ledger
-- rows: a quote writes no stock movement, payment, ledger entry or day close.
--
-- A quote's number is independent of the invoice sequence:
--   QTN-<device_code>-<seq>
-- The device quote counter is kept in kv.quote_seq on the till; devices.last_quote_seq
-- is the server-side watermark for enrolment and restore recovery.
--
-- The quote tables are ordered after `sales` in SYNC_IMPORT_ORDER because
-- quotations.converted_sale_id is a composite FK to a sale.

ALTER TABLE devices ADD COLUMN last_quote_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE quotations (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                  TEXT NOT NULL,
  quote_no            TEXT NOT NULL CHECK (length(quote_no) BETWEEN 1 AND 64),
  quote_seq           INTEGER NOT NULL CHECK (quote_seq > 0),
  branch_id           TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  staff_id            TEXT NOT NULL,
  customer_id         TEXT,
  customer_name       TEXT NOT NULL DEFAULT '' CHECK (length(customer_name) <= 60),
  customer_phone      TEXT NOT NULL DEFAULT '' CHECK (length(customer_phone) <= 30),
  business_date       TEXT NOT NULL,
  valid_until         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','cancelled')),
  line_count          INTEGER NOT NULL CHECK (line_count > 0),
  items_qty_milli     INTEGER NOT NULL CHECK (items_qty_milli > 0),
  gross_total         INTEGER NOT NULL CHECK (gross_total >= 0),
  item_discount_total INTEGER NOT NULL DEFAULT 0 CHECK (item_discount_total >= 0),
  subtotal            INTEGER NOT NULL CHECK (subtotal >= 0),
  bill_discount_type  TEXT CHECK (bill_discount_type IN ('rs','pct')),
  bill_discount_value INTEGER NOT NULL DEFAULT 0 CHECK (bill_discount_value >= 0),
  bill_discount       INTEGER NOT NULL DEFAULT 0 CHECK (bill_discount >= 0),
  tax_rate_bp         INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 5000),
  tax                 INTEGER NOT NULL DEFAULT 0 CHECK (tax >= 0),
  tax_inclusive       INTEGER NOT NULL DEFAULT 0 CHECK (tax_inclusive IN (0,1)),
  round_total_to      INTEGER NOT NULL DEFAULT 1 CHECK (round_total_to > 0),
  rounding            INTEGER NOT NULL DEFAULT 0,
  total               INTEGER NOT NULL CHECK (total >= 0),
  note                TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  converted_sale_id   TEXT,
  converted_at        INTEGER,
  cancelled_reason    TEXT NOT NULL DEFAULT '' CHECK (length(cancelled_reason) <= 120),
  cancelled_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  rev                 INTEGER NOT NULL DEFAULT 1,
  updated_by          TEXT,
  CHECK (valid_until >= business_date),
  CHECK (total = subtotal - bill_discount + (CASE WHEN tax_inclusive = 1 THEN 0 ELSE tax END) + rounding),
  CHECK ((status = 'converted') = (converted_sale_id IS NOT NULL)),
  CHECK ((status = 'converted') = (converted_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR length(cancelled_reason) BETWEEN 1 AND 120),
  CHECK (status = 'cancelled' OR cancelled_reason = ''),
  UNIQUE (tenant_id, quote_no),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, converted_sale_id) REFERENCES sales(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX quotations_date ON quotations (tenant_id, business_date, status);
CREATE INDEX quotations_validity ON quotations (tenant_id, status, valid_until);
CREATE INDEX quotations_customer ON quotations (tenant_id, customer_id, created_at) WHERE customer_id IS NOT NULL;
CREATE INDEX quotations_sale ON quotations (tenant_id, converted_sale_id) WHERE converted_sale_id IS NOT NULL;

CREATE TABLE quotation_lines (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                  TEXT NOT NULL,
  quote_id            TEXT NOT NULL,
  line_no             INTEGER NOT NULL CHECK (line_no > 0),
  product_id          TEXT,
  name_snapshot       TEXT NOT NULL CHECK (length(name_snapshot) BETWEEN 1 AND 120),
  sku_snapshot        TEXT NOT NULL DEFAULT '' CHECK (length(sku_snapshot) <= 64),
  qty_milli           INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_price          INTEGER NOT NULL CHECK (unit_price >= 0),
  gross               INTEGER NOT NULL CHECK (gross >= 0),
  discount_type       TEXT CHECK (discount_type IN ('rs','pct')),
  discount_value      INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  discount            INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  net                 INTEGER NOT NULL CHECK (net >= 0),
  note                TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 60),
  unit_cost_snapshot  INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_snapshot >= 0),
  bundle_id           TEXT,
  bundle_group        TEXT,
  bundle_name         TEXT CHECK (bundle_name IS NULL OR length(bundle_name) BETWEEN 1 AND 80),
  bundle_qty          INTEGER CHECK (bundle_qty IS NULL OR bundle_qty > 0),
  bundle_price        INTEGER CHECK (bundle_price IS NULL OR bundle_price >= 0),
  bundle_component_qty_milli INTEGER CHECK (bundle_component_qty_milli IS NULL OR bundle_component_qty_milli > 0),
  bundle_discount     INTEGER NOT NULL DEFAULT 0 CHECK (bundle_discount >= 0),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  rev                 INTEGER NOT NULL DEFAULT 1,
  updated_by          TEXT,
  CHECK (net = gross - discount),
  UNIQUE (tenant_id, quote_id, line_no),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotations(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX quotation_lines_quote ON quotation_lines (tenant_id, quote_id);
CREATE INDEX quotation_lines_product ON quotation_lines (tenant_id, product_id);

UPDATE meta SET value = '10' WHERE key = 'schema_version';
