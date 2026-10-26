# 02 — Data model

This document is the **source of truth** for table and column names. D1 (server) and Dexie (till) use the same table names and the same column names, so a row can be pushed and pulled without mapping.

## 1. Conventions

| Topic | Rule |
|---|---|
| Tenant | Every tenant-scoped D1 table starts with `tenant_id TEXT NOT NULL REFERENCES tenants(id)` and has **`PRIMARY KEY (tenant_id, id)`**; every reference to another tenant-scoped row is a **composite foreign key** `(tenant_id, x_id) → parent(tenant_id, id)`; every UNIQUE rule and every index starts with `tenant_id` ([13 §3.2](13-multi-tenancy.md#32-decision)). `tenant_id` is set by the Worker from the device token, never sent by tills, and not stored in Dexie (a till's Dexie database holds exactly one tenant). |
| IDs | `id TEXT NOT NULL`, a 26-char **ULID** generated on the device (`ulidx` `monotonicFactory()`), unique within its tenant (the key is `(tenant_id, id)`). Singleton rows use fixed IDs (`shop.id = 'shop'`, one per tenant). |
| Money | `INTEGER` paisa (1 Rs = 100). Columns: `price`, `amount`, `total`, `*_cost`, `*_total`, `*_alloc`, `credit_limit`, etc. Always integers, may be negative only where stated. |
| Quantity | `INTEGER` milli-units, column suffix `_milli` (1 pc = 1000, 1.25 kg = 1250). |
| Percent | `INTEGER` basis points, suffix `_bp` (17% = 1700). |
| Time | `INTEGER` epoch **milliseconds** UTC, suffix `_at`. |
| Business date | `TEXT` `YYYY-MM-DD` in the shop time zone (that tenant's `shop.timezone`), column `business_date`. Computed on the device when the row is created. |
| Booleans | `INTEGER` 0/1 with `CHECK (x IN (0,1))`. |
| Enums | `TEXT` with `CHECK (x IN (...))`. |
| JSON | `TEXT` containing JSON, suffix `_json`. |
| Phone | `TEXT` E.164 (`+923001234567`). UI shows `0300 1234567`. |
| Strictness | All D1 tables are `STRICT`. |

### 1.1 Table kinds

| Kind | Tables | Rules |
|---|---|---|
| **Master** (mutable) | `shop`, `branches`, `staff`, `categories`, `products`, `product_barcodes`, `customers`, `suppliers`, `expense_categories`, `promises` | Have `created_at`, `updated_at`, `deleted_at`, `rev`, `updated_by`. Updated by `upsert` ops with optimistic `base_rev` ([03-sync §5](03-sync.md#5-conflict-rules)). Soft delete only. |
| **Ledger** (append-only) | `sales`, `sale_lines`, `payments`, `refunds`, `refund_lines`, `sale_voids`, `ledger_entries`, `stock_movements`, `purchases`, `purchase_lines`, `supplier_returns`, `supplier_return_lines`, `expenses`, `cash_moves`, `day_closes`, `audit_log` | Insert only. Never updated or deleted, except the **derived cache** column `sales.status` which both sides recompute ([§4](#4-derived-values)). |
| **Server-owned** (tenant-scoped) | `devices`, `enrolment_codes`, `owner_email_codes`, `change_log`, `applied_ops`, `sync_conflicts` | Written only by the Worker, always with the caller's `tenant_id`. `devices` and `sync_conflicts` are pulled read-only by tills (`devices` without `token_hash`); `owner_email_codes` is never pulled or exported. |
| **Platform** (not tenant-scoped) | `tenants`, `tenant_usage`, `expense_category_templates`, `meta` | Primary database only; written by the Worker and the operator console; never pulled by tills ([13 §5](13-multi-tenancy.md#5-tenant-scoping-rules-for-implementers)). |
| **Local-only** (Dexie) | `outbox`, `kv`, `carts`, `held_bills`, `file_queue`, `print_jobs`, `stock_levels`, `party_balances`, `pull_shadow` | Never synced. |

Common columns on every synced row: `id`, `created_at` (plus `tenant_id` in D1 only). Ledger rows also carry `device_id`, `staff_id`, `branch_id`, `business_date` where listed.

## 2. D1 schema (migration `0001_init.sql`)

Run with `PRAGMA foreign_keys = ON` (D1 default). Composite foreign keys make SQLite itself reject a row that references another tenant's row (`FOREIGN KEY constraint failed` → op `rejected` / `FOREIGN_KEY`). Platform tables come first because tenant tables reference `tenants`. The push handler runs `PRAGMA defer_foreign_keys = ON` at the start of each batch so rows can arrive in any order within one batch.

```sql
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
```

### 2.1 Seed data (migration `0002_seed.sql`)

```sql
INSERT INTO expense_category_templates (code, name_en, name_ur, icon, sort_order) VALUES
 ('electricity','Electricity','بجلی','bolt',1),
 ('tea_snacks','Tea & snacks','چائے پانی','cup',2),
 ('transport','Transport','کرایہ','truck',3),
 ('salary','Salary','تنخواہ','users',4),
 ('rent','Rent','کرایہ دکان','home',5),
 ('repairs','Repairs','مرمت','wrench',6),
 ('internet_phone','Internet & phone','انٹرنیٹ و فون','wifi',7),
 ('other','Other','دیگر','dots',99);
```

No tenant exists after the migrations. Creating a tenant (`POST /api/admin/tenants`, [13 §7.1](13-multi-tenancy.md#71-onboarding-a-new-shop-d-072)) runs one batch:

```
INSERT INTO tenants (id, slug, display_name, owner_email, restore_epoch, created_by_email, created_at, updated_at) VALUES (?1, ?2, ?3, ?7, CAST(?4 AS TEXT), ?5, ?4, ?4);
INSERT INTO branches (tenant_id, id, name, bill_prefix, is_default, created_at, updated_at, updated_by) VALUES (?1, ?6, 'Main', 'INV', 1, ?4, ?4, 'server');
INSERT INTO expense_categories (tenant_id, id, code, name_en, name_ur, icon, is_system, sort_order, created_at, updated_at)
  SELECT ?1, code, code, name_en, name_ur, icon, 1, sort_order, 0, 0 FROM expense_category_templates;   -- created_at/updated_at 0 = system seed (EpochMs allows 0)
INSERT INTO change_log (tenant_id, tbl, row_id, op, row_json, at) SELECT …;   -- one per branch / expense category row, built as in 03 §4.1
INSERT INTO enrolment_codes (code_hash, tenant_id, device_name, branch_id, grants_admin, created_by, created_at, expires_at) VALUES (…, 1, 'operator:<email>', ?4, ?4 + 72 h);
```

There is deliberately **no "Supplier" expense category**: money paid to suppliers is recorded with Pay supplier or "Paid now" on a delivery, so it reduces the supplier balance and is counted once in day close (REQ-B01).

The default branch (`name 'Main'`, `bill_prefix 'INV'`, `is_default 1`) and the expense categories are created with the tenant (above). The `shop` row and the owner `staff` row are created by the setup wizard on the tenant's first enrolled device ([screens/01](screens/01-setup-wizard.md)).

## 3. Dexie schema (till)

`packages/db/src/dexie.ts`. Same table and column names as D1, **without `tenant_id`**: each tenant has its own Dexie database named **`bikri-<tenant_id>`**, so a till's local data can only ever be one shop's (D-073). `localStorage['bikri.active_tenant']` (non-secret) names the database to open; before enrolment there is none. Index strings list only indexed fields; Dexie stores every column.

```ts
// Example only — exact index strings to implement.
export const DEXIE_SCHEMA_V1 = {
  // master
  shop: 'id',
  branches: 'id, deleted_at',
  devices: 'id, branch_id',
  staff: 'id, active, deleted_at',
  categories: 'id, sort_order, deleted_at',
  products: 'id, sku, category_id, name_en, updated_at, deleted_at',
  product_barcodes: 'id, barcode, product_id, deleted_at',   // NOT unique in Dexie: D1 uniqueness ignores soft-deleted rows; the repository checks "no other non-deleted row" for sku and barcode
  customers: 'id, name, phone, deleted_at',
  suppliers: 'id, name, deleted_at',
  expense_categories: 'id, code, sort_order',
  promises: 'id, customer_id, [status+promised_on]',
  sync_conflicts: 'id, row_id, at',   // pulled read-only
  // ledger
  sales: 'id, &invoice_no, business_date, customer_id, created_at, [device_id+invoice_seq], status',
  sale_lines: 'id, sale_id, product_id',
  payments: 'id, business_date, sale_id, [party_type+party_id], [device_id+created_at]',
  refunds: 'id, sale_id, business_date, [device_id+created_at]',
  refund_lines: 'id, refund_id, sale_line_id',
  sale_voids: 'id, &sale_id',
  ledger_entries: 'id, [party_type+party_id+created_at], source_id',
  stock_movements: 'id, [product_id+created_at], business_date',
  purchases: 'id, [supplier_id+created_at], business_date',
  purchase_lines: 'id, purchase_id, product_id',
  supplier_returns: 'id, [supplier_id+created_at], purchase_id, business_date',
  supplier_return_lines: 'id, return_id, product_id, purchase_line_id',
  expenses: 'id, business_date, category_id, [device_id+created_at]',
  cash_moves: 'id, [device_id+created_at]',
  day_closes: 'id, [device_id+period_end], business_date',
  audit_log: 'id, [entity+entity_id], created_at',
  // local-only
  outbox: '++seq, &op_id, status, created_at',
  kv: 'key',
  carts: 'id',                    // up to 3 open carts: 'c1','c2','c3'
  held_bills: 'id, created_at',
  file_queue: '++id, status',
  print_jobs: 'id, status, created_at',
  stock_levels: 'product_id',     // { product_id, on_hand_milli }
  party_balances: '[party_type+party_id]', // { party_type, party_id, balance, last_activity_at }
  pull_shadow: '[tbl+id]',        // server rows skipped while a local edit was pending (03 §4.2)
};
```

### 3.1 Local-only tables

| Table | Shape | Purpose |
|---|---|---|
| `outbox` | `{ seq, op_id, tx_id, tbl, kind, row_id, row, base_rev?, changed_fields?, created_at, status: 'pending'|'failed', attempts, last_error? }` | Ops waiting to be pushed; acknowledged entries are deleted ([03-sync §3](03-sync.md#3-outbox)) |
| `kv` | `{ key, value }` | `tenant` (id, display_name; from enrolment and `/api/me`), `device` (id, name, code, branch_id, is_admin), `device_token`, `invoice_seq` (last issued number, never decreases, 03 §5), `pull_cursor`, `restore_epoch`, `last_push_at`, `last_pull_at`, `printer` (shape in [06 §8](06-printing.md#8-printer-setup-and-test-print-per-device)), `logo_bitmap`, `display` (theme, text_size, font), `language`, `locked_staff_id`, `pin_failures` (05 §4), `stock_count_draft` (screens/09), `setup_draft` (screens/01), `label` (label size and options, [screens/20](screens/20-barcode-labels.md)), `snapshot_state` (resumable snapshot progress, 03 §4.3), `last_full_sync_at`, `poll_after_ms` (from the server, 13 §6), `tenant_status` (`{ status, since, learned_at }` from `/api/me`, pull and push responses; `read_only` puts the till in read-only mode, 13 §7.2), `support` (`{ until, reason }` while operator support access is active, 13 §7.5) |
| `carts` | `{ id: 'c1'|'c2'|'c3', customer_id?, lines: CartLine[], bill_discount?: {type, value}, note, updated_at }` | Open carts, survive reload |
| `held_bills` | same as cart + `{ held_at, held_by, label }` | Parked bills |
| `file_queue` | `{ id, kind: 'product_image'|'logo', target_id, blob, sha256, status }` | Images waiting for upload |
| `print_jobs` | `{ id, sale_id?, refund_id?, kind, status: 'queued'|'printing'|'done'|'failed', error?, created_at }` | Print history and retry |
| `stock_levels` | `{ product_id, on_hand_milli }` | Cache = Σ `stock_movements.qty_delta_milli`; updated in the same transaction as each movement; rebuildable |
| `party_balances` | `{ party_type, party_id, balance, last_activity_at, oldest_unpaid_at }` | Cache = Σ `ledger_entries.amount`; rebuildable |

`CartLine = { key, product_id | null, name, sku, qty_milli, unit_price, discount_type?, discount_value, unit_cost, image_key? }`.

### 3.2 Rebuild

Settings → Sync → "Rebuild local data" (owner only; [screens/17](screens/17-settings.md#sync-everyone-sees-status-actions-need-owner)) pushes pending ops, then clears `stock_levels` and `party_balances` and recomputes them from movements and ledger entries. The app also runs a silent consistency check once a day at first unlock: recompute 20 random products and parties; if any differ, rebuild and log `cache_rebuilt` in `audit_log`.

## 4. Derived values

| Value | Formula | Where |
|---|---|---|
| Stock on hand | Σ `stock_movements.qty_delta_milli` for the product (and branch, v2) | `stock_levels` cache on till; computed on demand on server |
| Customer balance | Σ `ledger_entries.amount` where `party_type='customer'` | `party_balances`; > 0 means the customer owes the shop |
| Supplier balance | Σ `ledger_entries.amount` where `party_type='supplier'` | `party_balances`; > 0 means the shop owes the supplier |
| `sales.status` | `void` if a `sale_voids` row exists; else `refunded` if every line's refunded qty = sold qty; else `part_refunded` if any refund; else `paid` | Recomputed on the till and on the server whenever a refund or void for the sale is inserted. Not sent in ops. |
| Average cost | [07 §7](07-money-rules.md#7-cost-weighted-average) | Server recomputes and writes `products.avg_cost`; till computes provisionally |

## 5. Record recipes (which rows each action writes)

All rows of one action are written in **one Dexie transaction** together with their outbox ops.

| Action | Rows written |
|---|---|
| Sale | 1 `sales`; n `sale_lines` (with `warranty_until` when the product has `warranty_days > 0`); 0..3 `payments` (direction in, purpose sale, one per method used); 1 `ledger_entries` (+udhaar) if udhaar part > 0; n `stock_movements` (reason `sale`, −qty) for lines with `track_stock = 1`; `audit_log` if any discount exceeded the cashier limit (manager override) |
| Refund | 1 `refunds` (split into paid part and udhaar part, [07 §6.1](07-money-rules.md#61-refunds-on-udhaar-bills)); n `refund_lines`; 1 `payments` (direction out, purpose refund, `method`, `amount`) if `amount > 0`; 1 `ledger_entries` (customer, −`udhaar_part`, source refund) if `udhaar_part > 0`; `stock_movements` (`refund_return`, +qty) for restocked lines; `audit_log` |
| Void | 1 `sale_voids`; reversing `payments` (direction out, purpose void) for each original payment; reversing `ledger_entries` (−udhaar); `stock_movements` (`void_return`, +qty); `audit_log` |
| Reissue | Void (above) + a new sale with `replaces_sale_id`, then `sale_voids.replacement_sale_id` is known up front because the new sale ID is generated before writing |
| Customer payment | 1 `payments` (in, customer_payment, party) + 1 `ledger_entries` (−amount, source payment) ; promise status → `kept` if the balance reaches ≤ promised remaining |
| Delivery (purchase) | 1 `purchases`; n `purchase_lines`; n `stock_movements` (`purchase`, +qty, `unit_cost` = `landed_unit_cost`); 1 `ledger_entries` (supplier, +total, source purchase); if paid_now > 0: 1 `payments` (out, purchase_paid_now) + 1 `ledger_entries` (supplier, −paid_now, source payment); product `last_cost` upsert per line |
| Pay supplier | 1 `payments` (out, supplier_payment) + 1 `ledger_entries` (supplier, −amount) |
| Return to supplier | 1 `supplier_returns`; n `supplier_return_lines`; n `stock_movements` (`supplier_return`, −qty, `ref_type` supplier_return, `unit_cost` NULL so avg cost is not recomputed) for lines with `track_stock = 1`; 1 `ledger_entries` (supplier, −total, source supplier_return); if `refund_received > 0`: 1 `payments` (direction in, purpose `supplier_refund`, `refund_method`, party supplier, `supplier_return_id`) + 1 `ledger_entries` (supplier, +refund_received, source payment); 1 `audit_log` `supplier_return` |
| Stock adjust | 1 `stock_movements` (reason code, signed qty, note); for `count`: qty = counted − on_hand **at the moment of saving** (not the frozen "expected" shown when the count started) |
| Expense | 1 `expenses`; a reversal is 1 more `expenses` row with `reverses_id` |
| Pay-in / pay-out | 1 `cash_moves` |
| Day close | 1 `day_closes`; forces a sync |
| Opening balance for a customer/supplier | 1 `ledger_entries` (source opening) |
