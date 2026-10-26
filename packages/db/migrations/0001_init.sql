-- Bikri D1 schema v1 (multi-tenant, D-069/D-077). Source: docs/02-data-model.md §2 (source of truth, D-045).
-- Keep this file identical to the doc's SQL block (checked by tools/check-docs.mjs).

-- ============ platform (not tenant-scoped; primary database only; never pulled by tills, 13 §5) ============
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('last_prune_at', '0'), ('prune_cursor', '');
-- prune_cursor: tenant id where the nightly prune continues (03 §4.4)
-- per-tenant sync state (restore_epoch, restore_point_at, change_log_floor) lives on `tenants`; usage on `tenant_usage`

CREATE TABLE tenants (
  id                  TEXT PRIMARY KEY,               -- ULID, created by the operator (13 §7.1)
  slug                TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 3 AND 30 AND slug NOT GLOB '*[^a-z0-9-]*'),
  display_name        TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','read_only','suspended','maintenance','deleting','deleted')),  -- 13 §7.2
  status_reason       TEXT NOT NULL DEFAULT '' CHECK (length(status_reason) <= 200),  -- operator's reason for the last status change (also in the shop's audit_log)
  status_changed_at   INTEGER,                        -- server time of the last status change; for 'read_only' it is the read-only start
  status_changed_by   TEXT,                           -- 'operator:<email>' or 'cron'
  db_shard            TEXT NOT NULL DEFAULT 'DB',     -- D1 binding holding this tenant's rows (13 §4); v1 always 'DB'
  daily_write_budget  INTEGER NOT NULL DEFAULT 7000 CHECK (daily_write_budget >= 0),   -- D1 rows written per UTC day (13 §6)
  poll_after_ms       INTEGER NOT NULL DEFAULT 60000 CHECK (poll_after_ms BETWEEN 15000 AND 3600000),
  restore_epoch       TEXT NOT NULL,                  -- set to a NEW unique value (epoch ms) after any restore of this tenant (09 §3), never incremented
  restore_point_at    INTEGER NOT NULL DEFAULT 0,     -- epoch ms of the point in time this tenant's data was restored to
  change_log_floor    INTEGER NOT NULL DEFAULT 0,     -- highest change_log.seq of this tenant deleted by the prune (03 §4.4)
  note                TEXT NOT NULL DEFAULT '',
  owner_email         TEXT CHECK (owner_email IS NULL OR (length(owner_email) <= 254 AND owner_email = lower(owner_email) AND owner_email LIKE '%_@_%')),  -- shop owner's sign-in email (05 §3.2); set by the operator
  last_owner_export_at INTEGER,                       -- start of the last owner server export (rate limit, 13 §7.3)
  support_until       INTEGER,                        -- operator support access active while > now (13 §7.5)
  support_reason      TEXT NOT NULL DEFAULT '' CHECK (length(support_reason) <= 200),
  created_by_email    TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER                         -- set when status becomes 'deleted' (tombstone)
) STRICT;

CREATE TABLE tenant_usage (                          -- free-tier accounting per shop per UTC day (13 §6)
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  day           TEXT NOT NULL,                        -- YYYY-MM-DD in UTC (D1 limits reset at 00:00 UTC)
  pushes        INTEGER NOT NULL DEFAULT 0,
  rows_written  INTEGER NOT NULL DEFAULT 0,           -- Σ D1 meta.rows_written of this tenant's batches
  rows_read     INTEGER NOT NULL DEFAULT 0,           -- Σ D1 meta.rows_read (pull/snapshot reads added best effort)
  PRIMARY KEY (tenant_id, day)
) STRICT;

CREATE TABLE expense_category_templates (            -- copied into expense_categories when a tenant is created
  code        TEXT PRIMARY KEY,
  name_en     TEXT NOT NULL,
  name_ur     TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT 'receipt',
  sort_order  INTEGER NOT NULL DEFAULT 0
) STRICT;

-- ============ server-owned (tenant-scoped) ============
CREATE TABLE change_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,       -- one stream per database; tills read only their tenant's rows
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  tbl       TEXT NOT NULL,
  row_id    TEXT NOT NULL,
  op        TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  row_json  TEXT NOT NULL,              -- full row after the change, WITHOUT tenant_id
  device_id TEXT,                        -- origin device (null = server)
  at        INTEGER NOT NULL
) STRICT;
CREATE INDEX change_log_tenant_seq ON change_log (tenant_id, seq);
CREATE INDEX change_log_row ON change_log (tenant_id, tbl, row_id);
CREATE INDEX change_log_at ON change_log (at);       -- nightly prune across tenants

CREATE TABLE applied_ops (
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  op_id      TEXT NOT NULL,              -- ULID from the device outbox
  device_id  TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  result     TEXT NOT NULL CHECK (result IN ('applied','conflict_merged','rejected')),
  error_code TEXT,
  PRIMARY KEY (tenant_id, op_id)
) STRICT;
CREATE INDEX applied_ops_device ON applied_ops (tenant_id, device_id, applied_at);
CREATE INDEX applied_ops_at ON applied_ops (applied_at);

CREATE TABLE sync_conflicts (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  id          TEXT NOT NULL,
  op_id       TEXT NOT NULL,
  tbl         TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'field_merge' CHECK (kind IN ('field_merge','over_refund','refund_after_void','over_return')),
  base_rev    INTEGER,                   -- field_merge only
  server_rev  INTEGER,                   -- field_merge only
  fields_json TEXT NOT NULL,             -- field_merge: fields the client tried to change; others: { sale_id, row_ids, excess_milli }
  resolution  TEXT NOT NULL CHECK (resolution IN ('merged','client_lost','needs_owner','acknowledged')),
  at          INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE devices (
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  id                TEXT NOT NULL,
  name              TEXT NOT NULL,                  -- "Counter 1"
  branch_id         TEXT NOT NULL,
  device_code       TEXT NOT NULL,                  -- 'A'..'Z' then 'AA'.. ; unique per branch
  token_hash        TEXT NOT NULL UNIQUE,           -- hex SHA-256 of the bearer token; globally unique, identifies the tenant
  is_admin          INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),  -- may call the shop-admin API (05 §3)
  kind              TEXT NOT NULL DEFAULT 'till' CHECK (kind IN ('till','support')),  -- 'support' = operator support browser (13 §7.5): never admin, never pushes
  expires_at        INTEGER,                        -- support devices: token stops working after this (= tenants.support_until at enrolment)
  read_only_seen_at INTEGER,                        -- server time this device was first told the shop is read-only (13 §7.2); NULL when active
  enrolled_at       INTEGER NOT NULL,
  enrolled_by       TEXT NOT NULL,                  -- 'operator:<email>' or 'device:<device id>' that created the code
  revoked_at        INTEGER,
  last_seen_at      INTEGER,
  last_invoice_seq  INTEGER NOT NULL DEFAULT 0,     -- highest invoice_seq seen from this device
  pending_ops       INTEGER NOT NULL DEFAULT 0,     -- from X-Bikri-Pending header (03 §6)
  oldest_pending_at INTEGER,                        -- created_at of the oldest unsynced op, null = none
  user_agent        TEXT,
  app_version       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (tenant_id, branch_id, device_code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE enrolment_codes (
  code_hash         TEXT PRIMARY KEY,               -- SHA-256 of the 8-char code; globally unique, identifies the tenant
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  device_name       TEXT NOT NULL,
  branch_id         TEXT NOT NULL,
  grants_admin      INTEGER NOT NULL DEFAULT 0 CHECK (grants_admin IN (0,1)),  -- owner pairing code (13 §7.1) or admin till
  kind              TEXT NOT NULL DEFAULT 'till' CHECK (kind IN ('till','support')),  -- 'support': operator support access (13 §7.5), never grants_admin
  created_by        TEXT NOT NULL,                  -- 'operator:<email>' or 'device:<device id>'
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,               -- created_at + 15 min; owner pairing codes + 72 h
  used_at           INTEGER,
  device_id         TEXT,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
) STRICT;
CREATE INDEX enrolment_codes_tenant ON enrolment_codes (tenant_id, expires_at);

CREATE TABLE owner_email_codes (                     -- one-time sign-in codes for shop owners (05 §3.2); never pulled by tills
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  id          TEXT NOT NULL,                        -- ULID
  device_id   TEXT NOT NULL,                        -- the admin device that asked; the code works only there
  staff_id    TEXT NOT NULL,                        -- the owner staff row unlocked on that device
  code_hash   TEXT NOT NULL,                        -- hex HMAC-SHA256(OWNER_CODE_KEY, tenant_id || id || code)
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,                     -- created_at + 10 min
  used_at     INTEGER,
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX owner_email_codes_time ON owner_email_codes (tenant_id, created_at);

-- ============ master ============
CREATE TABLE shop (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                    TEXT NOT NULL CHECK (id = 'shop'),
  name                  TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  business_type         TEXT NOT NULL CHECK (business_type IN ('grocery','general','pharmacy','clothing','electronics','mobile','bakery','hardware','other')),
  phone                 TEXT NOT NULL,
  address               TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 120),
  currency              TEXT NOT NULL DEFAULT 'PKR' CHECK (currency = 'PKR'),
  timezone              TEXT NOT NULL DEFAULT 'Asia/Karachi',
  receipt_header        TEXT NOT NULL DEFAULT '' CHECK (length(receipt_header) <= 120),
  receipt_footer        TEXT NOT NULL DEFAULT 'Shukriya! Phir tashreef laiye.' CHECK (length(receipt_footer) <= 160),
  show_payment_details  INTEGER NOT NULL DEFAULT 1 CHECK (show_payment_details IN (0,1)),
  show_cashier_on_receipt INTEGER NOT NULL DEFAULT 1 CHECK (show_cashier_on_receipt IN (0,1)),
  logo_key              TEXT,                         -- relative key 'shop/logo-<sha256>.png'; stored in R2 under 't/<tenant_id>/' (04 §3.5)
  tax_rate_bp           INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 5000),
  tax_label             TEXT NOT NULL DEFAULT 'Sales tax',
  tax_mode              TEXT NOT NULL DEFAULT 'exclusive' CHECK (tax_mode IN ('exclusive','inclusive')),  -- 'inclusive' = prices are MRP incl. tax; only offered when tax_rate_bp > 0 (07 §3)
  round_total_to        INTEGER NOT NULL DEFAULT 100 CHECK (round_total_to IN (1,100,500,1000)),  -- paisa
  cost_method           TEXT NOT NULL DEFAULT 'avg' CHECK (cost_method IN ('avg','last')),
  show_cost_on_till     INTEGER NOT NULL DEFAULT 0 CHECK (show_cost_on_till IN (0,1)),  -- cost/margin in expanded cart line for cost.view users
  number_grouping       TEXT NOT NULL DEFAULT 'intl' CHECK (number_grouping IN ('intl','lakh')),
  refund_rounding       TEXT NOT NULL DEFAULT 'nearest' CHECK (refund_rounding IN ('nearest','down','none')),
  city                  TEXT NOT NULL DEFAULT '' CHECK (length(city) <= 40),
  ntn                   TEXT NOT NULL DEFAULT '',     -- optional tax numbers, printed if set
  strn                  TEXT NOT NULL DEFAULT '',
  receipt_language      TEXT NOT NULL DEFAULT 'app' CHECK (receipt_language IN ('app','en','ur')),
  show_you_saved        INTEGER NOT NULL DEFAULT 0 CHECK (show_you_saved IN (0,1)),
  print_warranty        INTEGER NOT NULL DEFAULT 1 CHECK (print_warranty IN (0,1)),
  default_credit_limit  INTEGER CHECK (default_credit_limit >= 0),     -- applied to new customers; null = none
  setup_completed_at    INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER,
  rev                   INTEGER NOT NULL DEFAULT 1,
  updated_by            TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE branches (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id          TEXT NOT NULL,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  bill_prefix TEXT NOT NULL CHECK (length(bill_prefix) BETWEEN 1 AND 6 AND bill_prefix GLOB '[A-Z0-9]*'),
  address     TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX branches_prefix ON branches (tenant_id, bill_prefix) WHERE deleted_at IS NULL;

CREATE TABLE staff (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id              TEXT NOT NULL,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  role            TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  pin_hash        TEXT NOT NULL,                 -- base64 PBKDF2-SHA256(pin, salt, iterations, 32 bytes)
  pin_salt        TEXT NOT NULL,                 -- base64 16 random bytes
  pin_iterations  INTEGER NOT NULL DEFAULT 150000,
  pin_length      INTEGER NOT NULL DEFAULT 4 CHECK (pin_length BETWEEN 4 AND 6),
  max_discount_bp INTEGER NOT NULL DEFAULT 500 CHECK (max_discount_bp BETWEEN 0 AND 10000),
  permissions_json TEXT NOT NULL DEFAULT '{}',   -- per-person overrides: {"refund.create": true}
  color           TEXT NOT NULL DEFAULT 'c1',    -- avatar colour token c1..c8
  must_change_pin INTEGER NOT NULL DEFAULT 0 CHECK (must_change_pin IN (0,1)),  -- "let them choose at next unlock"
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  rev             INTEGER NOT NULL DEFAULT 1,
  updated_by      TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE categories (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id          TEXT NOT NULL,
  name_en     TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 40),
  name_ur     TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT 't1' CHECK (color IN ('t1','t2','t3','t4','t5','t6','t7','t8')),  -- tile colour token, 08 §2
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE products (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id              TEXT NOT NULL,
  name_en         TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 80),
  name_ur         TEXT NOT NULL DEFAULT '',
  brand           TEXT NOT NULL DEFAULT '',
  category_id     TEXT,
  sku             TEXT NOT NULL,                  -- generated if blank: 3 letters of name + '-' + 4 base32 chars
  unit            TEXT NOT NULL DEFAULT 'pc' CHECK (unit IN ('pc','pair','set','box','pack','dozen','m','kg','g','l','ml')),
  price           INTEGER NOT NULL CHECK (price >= 0),
  last_cost       INTEGER NOT NULL DEFAULT 0 CHECK (last_cost >= 0),
  avg_cost        INTEGER NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),   -- server-recomputed, see 07 §7
  min_stock_milli INTEGER NOT NULL DEFAULT 0,
  track_stock     INTEGER NOT NULL DEFAULT 1 CHECK (track_stock IN (0,1)),
  tax_rate_bp     INTEGER CHECK (tax_rate_bp BETWEEN 0 AND 5000),     -- v2: null = shop rate
  track_serial    INTEGER NOT NULL DEFAULT 0 CHECK (track_serial IN (0,1)),  -- v2
  warranty_days   INTEGER NOT NULL DEFAULT 0 CHECK (warranty_days BETWEEN 0 AND 3650),
  pack_size_milli INTEGER,                                            -- v2
  image_key       TEXT,                                               -- relative key 'products/<id>/<sha256>.webp'; R2 prefix 't/<tenant_id>/'
  notes           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  rev             INTEGER NOT NULL DEFAULT 1,
  updated_by      TEXT,
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX products_sku ON products (tenant_id, sku) WHERE deleted_at IS NULL;
CREATE INDEX products_category ON products (tenant_id, category_id);

CREATE TABLE product_barcodes (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id          TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  barcode     TEXT NOT NULL CHECK (length(barcode) BETWEEN 3 AND 64),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX product_barcodes_code ON product_barcodes (tenant_id, barcode) WHERE deleted_at IS NULL;
CREATE INDEX product_barcodes_product ON product_barcodes (tenant_id, product_id);

CREATE TABLE customers (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id           TEXT NOT NULL,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  phone        TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  credit_limit INTEGER CHECK (credit_limit >= 0),        -- null = no limit
  hard_limit   INTEGER NOT NULL DEFAULT 0 CHECK (hard_limit IN (0,1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  rev          INTEGER NOT NULL DEFAULT 1,
  updated_by   TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX customers_phone ON customers (tenant_id, phone);

CREATE TABLE suppliers (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id          TEXT NOT NULL,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  phone       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE expense_categories (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id          TEXT NOT NULL,                -- system rows use the code as id, e.g. 'electricity'
  code        TEXT NOT NULL,
  name_en     TEXT NOT NULL,
  name_ur     TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT 'receipt',
  is_system   INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  rev         INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT,
  UNIQUE (tenant_id, code),
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE promises (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id           TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  promised_on  TEXT NOT NULL,                  -- YYYY-MM-DD
  amount       INTEGER CHECK (amount > 0),     -- null = "the balance"
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','kept','broken','cancelled')),
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  rev          INTEGER NOT NULL DEFAULT 1,
  updated_by   TEXT,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX promises_due ON promises (tenant_id, status, promised_on);

-- ============ ledger (append-only) ============
CREATE TABLE sales (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                  TEXT NOT NULL,
  invoice_no          TEXT NOT NULL,      -- '<bill_prefix>-<device_code>-<seq>' e.g. 'INV-A-1042'
  invoice_seq         INTEGER NOT NULL,
  branch_id           TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  staff_id            TEXT NOT NULL,
  customer_id         TEXT,
  business_date       TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  line_count          INTEGER NOT NULL,
  items_qty_milli     INTEGER NOT NULL,
  gross_total         INTEGER NOT NULL,          -- Σ line gross
  item_discount_total INTEGER NOT NULL,          -- Σ line discount
  subtotal            INTEGER NOT NULL,          -- Σ line net
  bill_discount_type  TEXT CHECK (bill_discount_type IN ('rs','pct')),
  bill_discount_value INTEGER NOT NULL DEFAULT 0,-- paisa if rs, bp if pct
  bill_discount       INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp         INTEGER NOT NULL DEFAULT 0,
  tax                 INTEGER NOT NULL DEFAULT 0,
  tax_inclusive       INTEGER NOT NULL DEFAULT 0 CHECK (tax_inclusive IN (0,1)),  -- snapshot of shop.tax_mode = 'inclusive' at sale time
  rounding            INTEGER NOT NULL DEFAULT 0,-- signed
  total               INTEGER NOT NULL,
  paid_total          INTEGER NOT NULL,          -- cash+card+bank_wallet applied (excludes change)
  udhaar_amount       INTEGER NOT NULL DEFAULT 0,
  cash_tendered       INTEGER NOT NULL DEFAULT 0,
  change_given        INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','part_refunded','refunded','void')),  -- derived cache
  replaces_sale_id    TEXT, -- set when this bill reissues a voided one
  note                TEXT NOT NULL DEFAULT '',
  CHECK (total = subtotal - bill_discount + (CASE WHEN tax_inclusive = 1 THEN 0 ELSE tax END) + rounding),
  CHECK (paid_total + udhaar_amount = total),
  UNIQUE (tenant_id, invoice_no),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, replaces_sale_id) REFERENCES sales(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX sales_date ON sales (tenant_id, business_date, branch_id);
CREATE INDEX sales_customer ON sales (tenant_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX sales_device_seq ON sales (tenant_id, device_id, invoice_seq);

CREATE TABLE sale_lines (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                  TEXT NOT NULL,
  sale_id             TEXT NOT NULL,
  line_no             INTEGER NOT NULL,
  product_id          TEXT,   -- null for quick sale
  name_snapshot       TEXT NOT NULL,
  sku_snapshot        TEXT NOT NULL DEFAULT '',
  qty_milli           INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_price          INTEGER NOT NULL CHECK (unit_price >= 0),
  gross               INTEGER NOT NULL,
  discount_type       TEXT CHECK (discount_type IN ('rs','pct')),
  discount_value      INTEGER NOT NULL DEFAULT 0,
  discount            INTEGER NOT NULL DEFAULT 0,
  net                 INTEGER NOT NULL,
  bill_discount_alloc INTEGER NOT NULL DEFAULT 0,
  tax_alloc           INTEGER NOT NULL DEFAULT 0,
  rounding_alloc      INTEGER NOT NULL DEFAULT 0,
  unit_cost_snapshot  INTEGER NOT NULL DEFAULT 0,
  below_cost          INTEGER NOT NULL DEFAULT 0 CHECK (below_cost IN (0,1)),
  serial              TEXT,                            -- v2
  warranty_until      TEXT,                            -- v1: business_date + products.warranty_days when > 0 (YYYY-MM-DD), snapshotted so reprints never change
  created_at          INTEGER NOT NULL,
  UNIQUE (tenant_id, sale_id, line_no),
  CHECK (net = gross - discount),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES sales(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX sale_lines_product ON sale_lines (tenant_id, product_id);

CREATE TABLE payments (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id            TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  method        TEXT NOT NULL CHECK (method IN ('cash','card','bank_wallet')),
  purpose       TEXT NOT NULL CHECK (purpose IN ('sale','refund','void','customer_payment','supplier_payment','purchase_paid_now','supplier_refund')),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  cash_tendered INTEGER,                               -- cash 'in' only
  change_given  INTEGER,                               -- cash 'in' only
  reference     TEXT NOT NULL DEFAULT '',              -- card slip / wallet txn id
  sale_id       TEXT,
  refund_id     TEXT,
  purchase_id   TEXT,
  supplier_return_id TEXT,  -- purpose supplier_refund (direction in)
  party_type    TEXT CHECK (party_type IN ('customer','supplier')),
  party_id      TEXT,
  note          TEXT NOT NULL DEFAULT '',
  branch_id     TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  staff_id      TEXT NOT NULL,
  business_date TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, sale_id) REFERENCES sales(tenant_id, id),
  FOREIGN KEY (tenant_id, refund_id) REFERENCES refunds(tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_return_id) REFERENCES supplier_returns(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX payments_date ON payments (tenant_id, business_date, device_id);
CREATE INDEX payments_sale ON payments (tenant_id, sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX payments_party ON payments (tenant_id, party_type, party_id) WHERE party_id IS NOT NULL;

CREATE TABLE refunds (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id            TEXT NOT NULL,
  sale_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('whole','partial')),
  reason        TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
  method        TEXT CHECK (method IN ('cash','card','bank_wallet')),  -- method of the paid part; NULL when the whole refund goes to khata
  exact_amount  INTEGER NOT NULL CHECK (exact_amount > 0),   -- Σ refund_lines.amount (value of the returned goods)
  udhaar_part   INTEGER NOT NULL DEFAULT 0 CHECK (udhaar_part >= 0),  -- reduces the customer's khata (07 §6.1)
  rounding      INTEGER NOT NULL DEFAULT 0,                  -- cash rounding of the paid part only
  amount        INTEGER NOT NULL CHECK (amount >= 0),        -- money handed back = exact_amount − udhaar_part + rounding
  branch_id     TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  staff_id      TEXT NOT NULL,
  business_date TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  CHECK (amount = exact_amount - udhaar_part + rounding),
  CHECK ((method IS NULL) = (exact_amount - udhaar_part = 0)),
  CHECK (udhaar_part <= exact_amount),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES sales(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX refunds_sale ON refunds (tenant_id, sale_id);
CREATE INDEX refunds_date ON refunds (tenant_id, business_date);

CREATE TABLE refund_lines (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id           TEXT NOT NULL,
  refund_id    TEXT NOT NULL,
  sale_line_id TEXT NOT NULL,
  qty_milli    INTEGER NOT NULL CHECK (qty_milli > 0),
  amount       INTEGER NOT NULL CHECK (amount >= 0),  -- exact paisa share
  restock      INTEGER NOT NULL DEFAULT 1 CHECK (restock IN (0,1)),
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, refund_id) REFERENCES refunds(tenant_id, id),
  FOREIGN KEY (tenant_id, sale_line_id) REFERENCES sale_lines(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX refund_lines_line ON refund_lines (tenant_id, sale_line_id);

CREATE TABLE sale_voids (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                  TEXT NOT NULL,
  sale_id             TEXT NOT NULL,
  reason              TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
  replacement_sale_id TEXT,
  device_id           TEXT NOT NULL,
  staff_id            TEXT NOT NULL,
  business_date       TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  UNIQUE (tenant_id, sale_id),
  FOREIGN KEY (tenant_id, sale_id) REFERENCES sales(tenant_id, id),
  FOREIGN KEY (tenant_id, replacement_sale_id) REFERENCES sales(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE ledger_entries (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id            TEXT NOT NULL,
  party_type    TEXT NOT NULL CHECK (party_type IN ('customer','supplier')),
  party_id      TEXT NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount <> 0),  -- + increases what is owed; − settles
  source_type   TEXT NOT NULL CHECK (source_type IN ('sale','refund','void','payment','purchase','supplier_return','opening','adjustment')),
  source_id     TEXT,
  note          TEXT NOT NULL DEFAULT '',
  branch_id     TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  staff_id      TEXT NOT NULL,
  business_date TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX ledger_party ON ledger_entries (tenant_id, party_type, party_id, created_at);

CREATE TABLE stock_movements (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id              TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  qty_delta_milli INTEGER NOT NULL CHECK (qty_delta_milli <> 0),
  reason_code     TEXT NOT NULL CHECK (reason_code IN (
    'opening','purchase','sale','refund_return','void_return',
    'received_godown','received_local','received_other',
    'damaged','expired','lost','spoiled',
    'customer_return','wrong_item',
    'count','entry_fix',
    'transfer_in','transfer_out','supplier_return')),
  ref_type        TEXT CHECK (ref_type IN ('sale','refund','void','purchase','supplier_return','adjustment','opening','transfer')),
  ref_id          TEXT,
  unit_cost       INTEGER,                              -- required for opening, purchase, received_*
  note            TEXT NOT NULL DEFAULT '',
  branch_id       TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  staff_id        TEXT NOT NULL,
  business_date   TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX stock_movements_product ON stock_movements (tenant_id, product_id, created_at);

CREATE TABLE purchases (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                  TEXT NOT NULL,
  supplier_id         TEXT NOT NULL,
  supplier_invoice_no TEXT NOT NULL DEFAULT '',
  other_charges       INTEGER NOT NULL DEFAULT 0 CHECK (other_charges >= 0), -- freight etc. on the supplier's invoice, owed to the supplier
  total               INTEGER NOT NULL CHECK (total >= 0),                     -- Σ purchase_lines.line_total + other_charges
  paid_now            INTEGER NOT NULL DEFAULT 0 CHECK (paid_now >= 0),
  paid_method         TEXT CHECK (paid_method IN ('cash','card','bank_wallet')),
  line_count          INTEGER NOT NULL,
  note                TEXT NOT NULL DEFAULT '',
  branch_id           TEXT NOT NULL,
  device_id           TEXT NOT NULL,
  staff_id            TEXT NOT NULL,
  business_date       TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  CHECK (paid_now <= total),
  CHECK ((paid_now = 0) = (paid_method IS NULL)),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX purchases_supplier ON purchases (tenant_id, supplier_id, created_at);

CREATE TABLE purchase_lines (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id          TEXT NOT NULL,
  purchase_id TEXT NOT NULL,
  line_no     INTEGER NOT NULL,
  product_id  TEXT NOT NULL,
  qty_milli   INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_cost   INTEGER NOT NULL CHECK (unit_cost >= 0),           -- supplier price per unit (1000 milli)
  line_total  INTEGER NOT NULL,                                  -- mulDivRound(qty_milli, unit_cost, 1000)
  charges_alloc    INTEGER NOT NULL DEFAULT 0,                   -- share of purchases.other_charges, allocate() by line_total
  landed_unit_cost INTEGER NOT NULL,                             -- mulDivRound(line_total + charges_alloc, 1000, qty_milli); written to stock_movements.unit_cost
  created_at  INTEGER NOT NULL,
  UNIQUE (tenant_id, purchase_id, line_no),
  FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE supplier_returns (                 -- "Return to supplier" (screens/13), money rules 07 §10
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                TEXT NOT NULL,
  supplier_id       TEXT NOT NULL,
  purchase_id       TEXT,            -- optional: the delivery the goods came from
  reason            TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
  total             INTEGER NOT NULL CHECK (total > 0),       -- Σ supplier_return_lines.line_total; credited to the supplier ledger
  refund_received   INTEGER NOT NULL DEFAULT 0 CHECK (refund_received >= 0),  -- money the supplier paid back now
  refund_method     TEXT CHECK (refund_method IN ('cash','bank_wallet')),
  line_count        INTEGER NOT NULL,
  note              TEXT NOT NULL DEFAULT '',
  branch_id         TEXT NOT NULL,
  device_id         TEXT NOT NULL,
  staff_id          TEXT NOT NULL,
  business_date     TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  CHECK (refund_received <= total),
  CHECK ((refund_received = 0) = (refund_method IS NULL)),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX supplier_returns_supplier ON supplier_returns (tenant_id, supplier_id, created_at);

CREATE TABLE supplier_return_lines (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                TEXT NOT NULL,
  return_id         TEXT NOT NULL,
  line_no           INTEGER NOT NULL,
  product_id        TEXT NOT NULL,
  purchase_line_id  TEXT,       -- set when returned against a delivery line
  qty_milli         INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_credit       INTEGER NOT NULL CHECK (unit_credit >= 0),  -- default: linked landed_unit_cost, else avg_cost (else last_cost)
  line_total        INTEGER NOT NULL,                         -- mulDivRound(qty_milli, unit_credit, 1000)
  cost_snapshot     INTEGER NOT NULL CHECK (cost_snapshot >= 0),  -- products.avg_cost at return time (for the return difference report)
  created_at        INTEGER NOT NULL,
  UNIQUE (tenant_id, return_id, line_no),
  FOREIGN KEY (tenant_id, return_id) REFERENCES supplier_returns(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_line_id) REFERENCES purchase_lines(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX supplier_return_lines_pline ON supplier_return_lines (tenant_id, purchase_line_id) WHERE purchase_line_id IS NOT NULL;

CREATE TABLE expenses (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id            TEXT NOT NULL,
  category_id   TEXT NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  method        TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','card','bank_wallet')),
  payee         TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  reverses_id   TEXT,      -- set on a reversal row; counts as −amount in totals
  branch_id     TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  staff_id      TEXT NOT NULL,
  business_date TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, category_id) REFERENCES expense_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_id) REFERENCES expenses(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX expenses_date ON expenses (tenant_id, business_date);

CREATE TABLE cash_moves (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id            TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('pay_in','pay_out')),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  reason        TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
  branch_id     TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  staff_id      TEXT NOT NULL,
  business_date TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;

CREATE TABLE day_closes (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                 TEXT NOT NULL,
  device_id          TEXT NOT NULL,
  branch_id          TEXT NOT NULL,
  staff_id           TEXT NOT NULL,
  business_date      TEXT NOT NULL,
  period_start       INTEGER NOT NULL,     -- previous close's period_end, or device enrolment time
  period_end         INTEGER NOT NULL,     -- = created_at
  opening_cash       INTEGER NOT NULL,
  cash_sales         INTEGER NOT NULL,
  udhaar_cash_in     INTEGER NOT NULL,
  pay_ins            INTEGER NOT NULL,
  supplier_cash_in   INTEGER NOT NULL DEFAULT 0,  -- cash refunds received from suppliers (supplier returns)
  cash_refunds       INTEGER NOT NULL,
  cash_expenses      INTEGER NOT NULL,
  supplier_cash_out  INTEGER NOT NULL,
  pay_outs           INTEGER NOT NULL,
  expected_cash      INTEGER NOT NULL,
  counted_cash       INTEGER NOT NULL CHECK (counted_cash >= 0),
  difference         INTEGER NOT NULL,     -- counted − expected
  denominations_json TEXT,                 -- {"5000":2,"1000":7,...} optional
  note               TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL,
  CHECK (expected_cash = opening_cash + cash_sales + udhaar_cash_in + pay_ins + supplier_cash_in - cash_refunds - cash_expenses - supplier_cash_out - pay_outs),
  CHECK (difference = counted_cash - expected_cash),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX day_closes_device ON day_closes (tenant_id, device_id, period_end);

CREATE TABLE audit_log (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id          TEXT NOT NULL,
  action      TEXT NOT NULL,          -- see list in 05-auth-and-roles §7
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  device_id   TEXT NOT NULL,
  staff_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE INDEX audit_log_entity ON audit_log (tenant_id, entity, entity_id);
CREATE INDEX audit_log_time ON audit_log (tenant_id, created_at);
