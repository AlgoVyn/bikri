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
| **Master** (mutable) | `shop`, `branches`, `staff`, `categories`, `products`, `bundle_items`, `product_barcodes`, `customers`, `suppliers`, `expense_categories`, `promises` | Have `created_at`, `updated_at`, `deleted_at`, `rev`, `updated_by`. Updated by `upsert` ops with optimistic `base_rev` ([03-sync §5](03-sync.md#5-conflict-rules)). Soft delete only. |
| **Ledger** (append-only) | `sales`, `sale_lines`, `payments`, `refunds`, `refund_lines`, `sale_voids`, `ledger_entries`, `stock_movements`, `purchases`, `purchase_lines`, `supplier_returns`, `supplier_return_lines`, `expenses`, `cash_moves`, `day_closes`, `audit_log` | Insert only. Never updated or deleted, except the **derived cache** column `sales.status` which both sides recompute ([§4](#4-derived-values)). Migration `0010` enforces this with `BEFORE UPDATE`/`BEFORE DELETE` triggers; deletes are allowed only while the tenant is in `maintenance` (restore purge) or `deleting` (tenant deletion). |
| **Server-owned** (tenant-scoped) | `devices`, `branch_device_codes`, `enrolment_codes`, `owner_email_codes`, `change_log`, `change_log_watermarks`, `applied_ops`, `sync_conflicts` | Written only by the Worker, always with the caller's `tenant_id`. `devices` and `sync_conflicts` are pulled read-only by tills (`devices` without `token_hash` and `enrolled_by`); `owner_email_codes` and `branch_device_codes` are never pulled or exported. |
| **Platform** (not tenant-scoped) | `tenants`, `tenant_usage`, `expense_category_templates`, `meta`, `shop_requests`, `operator_audit` | Primary database only; written by the Worker and the operator console; never pulled by tills ([13 §5](13-multi-tenancy.md#5-tenant-scoping-rules-for-implementers)). |
| **Local-only** (Dexie) | `outbox`, `kv`, `carts`, `held_bills`, `file_queue`, `print_jobs`, `stock_levels`, `party_balances`, `pull_shadow` | Never synced. |

Common columns on every synced row: `id`, `created_at` (plus `tenant_id` in D1 only). Ledger rows also carry `device_id`, `staff_id`, `branch_id`, `business_date` where listed.

**Primary-key exceptions:** `change_log` is keyed by its global `seq`, `applied_ops` by `(tenant_id, op_id)`, and the enrolment/owner-email code tables by their unique hash keys; these are the exceptions listed in [10 §8 I20](10-testing.md#8-cross-tenant-isolation-suite-mandatory).

`shop.timezone` is an IANA zone. The setup wizard writes the default `Asia/Karachi`, and v1 has no per-shop picker; the Worker validates the value on push and import and the client falls back to the default if a stored value is unknown, so a typo cannot block selling (D-218).

## 2. D1 schema (migration `0001_init.sql`)

Run with `PRAGMA foreign_keys = ON` (D1 default). Composite foreign keys make SQLite itself reject a row that references another tenant's row (`FOREIGN KEY constraint failed` → op `rejected` / `FOREIGN_KEY`). Platform tables come first because tenant tables reference `tenants`. The push handler does not defer foreign keys (D-104): it sorts the statements of one push parents-first ([03 §4.1](03-sync.md#41-push--post-apisyncpush)), and the tills queue a parent row before any child that references it.

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
  code_hash         TEXT PRIMARY KEY,               -- HMAC-SHA256(OWNER_CODE_KEY, 'enrol:' || code) for new codes, legacy SHA-256 until expiry; globally unique, identifies the tenant
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

Product photos keep the uploaded format, so `image_key` ends in `.webp`, `.jpg` or `.png` (the SQL comment above shows the usual WebP resize output).

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

No tenant exists after the migrations. Creating a tenant (`POST /api/admin/tenants`, [13 §7.1](13-multi-tenancy.md#71-onboarding-a-new-shop-d-072-d-175) runs one batch:

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

### 2.2 Performance indexes (migration `0003_perf_indexes.sql`)

Additive indexes for T-062 hot lookups. They change no column and keep `SCHEMA_VERSION` at 1.

```sql
-- T-062: indexes for the refund/reversal/lookup hot paths. Additive only.
CREATE INDEX payments_refund ON payments (tenant_id, refund_id) WHERE refund_id IS NOT NULL;
CREATE INDEX payments_supplier_return ON payments (tenant_id, supplier_return_id) WHERE supplier_return_id IS NOT NULL;
CREATE INDEX expenses_reversal ON expenses (tenant_id, reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX ledger_source ON ledger_entries (tenant_id, source_type, source_id) WHERE source_id IS NOT NULL;
```

### 2.3 Bill prefix guard (migration `0004_bill_prefix_guard.sql`)

`branches.bill_prefix` must be 1–6 uppercase letters/digits. The original `GLOB '[A-Z0-9]*'` only checked the first character; these triggers check every character for direct SQL as well as API writes.

```sql
-- Tighten branches.bill_prefix for rows written directly as well as through the API.
-- SQLite's GLOB '[A-Z0-9]*' only constrains the first character; this trigger checks every one.
CREATE TRIGGER branches_bill_prefix_insert
BEFORE INSERT ON branches
WHEN NEW.bill_prefix GLOB '*[^A-Z0-9]*'
  OR length(NEW.bill_prefix) NOT BETWEEN 1 AND 6
BEGIN
  SELECT RAISE(ABORT, 'invalid bill_prefix');
END;

CREATE TRIGGER branches_bill_prefix_update
BEFORE UPDATE OF bill_prefix ON branches
WHEN NEW.bill_prefix GLOB '*[^A-Z0-9]*'
  OR length(NEW.bill_prefix) NOT BETWEEN 1 AND 6
BEGIN
  SELECT RAISE(ABORT, 'invalid bill_prefix');
END;
```

### 2.4 Device code history and open-conflict index (migration `0005_device_code_history.sql`)

Moving a device to another branch assigns a new `device_code`, but bills queued offline before the move still carry the old code. `devices.device_code_history` (comma-separated, last 20 codes) lets the server accept them; the till also updates its local `kv.device` from the pulled row. The index serves the operator overview and the shop's Sync screen (`resolution = 'needs_owner'`).

```sql
-- A device keeps the codes it was enrolled/moved with, so a bill queued before a
-- branch move still matches its invoice (the server accepts any historical code).
ALTER TABLE devices ADD COLUMN device_code_history TEXT NOT NULL DEFAULT '';

-- The operator and the tenant's Sync screen count open conflicts per shop.
CREATE INDEX sync_conflicts_open ON sync_conflicts (tenant_id, resolution);
```

### 2.5 Public shop requests (migration `0006_shop_requests.sql`)

A public registration request exists before a tenant. The operator reviews it, verifies the email through Cloudflare Email Routing, and only then approves it; approval creates the tenant and the owner pairing code (D-175). These are platform tables, not tenant-scoped.

```sql
-- Public shop registration requests (platform-level, 13 §7.1, D-175).
-- A request exists before a tenant: it is reviewed by the operator, the email is verified
-- through Cloudflare Email Routing, and only then is a tenant + owner pairing code created.
CREATE TABLE shop_requests (
  id                         TEXT PRIMARY KEY,
  shop_name                  TEXT NOT NULL CHECK (length(shop_name) BETWEEN 1 AND 60),
  owner_name                 TEXT NOT NULL CHECK (length(owner_name) BETWEEN 1 AND 60),
  email                      TEXT NOT NULL CHECK (length(email) <= 254 AND email = lower(email) AND email LIKE '%_@_%'),
  phone                      TEXT NOT NULL DEFAULT '' CHECK (length(phone) <= 30),
  city                       TEXT NOT NULL DEFAULT '' CHECK (length(city) <= 60),
  business_type              TEXT NOT NULL DEFAULT 'other' CHECK (length(business_type) <= 40),
  note                       TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  status                     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awaiting_email','email_verified','approving','approved','rejected','failed')),
  email_verification_sent_at INTEGER,
  email_verified_at          INTEGER,
  email_checked_at           INTEGER,
  cloudflare_address_id      TEXT,
  tenant_id                  TEXT REFERENCES tenants(id),
  claim_tenant_id            TEXT,              -- pre-generated id while approval is in progress
  reject_reason              TEXT NOT NULL DEFAULT '' CHECK (length(reject_reason) <= 200),
  last_error                 TEXT NOT NULL DEFAULT '' CHECK (length(last_error) <= 200),
  reviewed_by                TEXT,
  reviewed_at                INTEGER,
  status_token_hash          TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
) STRICT;

-- One active request per email. A rejected or approved email may submit again (a second shop).
CREATE UNIQUE INDEX shop_requests_active_email ON shop_requests (lower(email))
  WHERE status IN ('pending','awaiting_email','email_verified','approving');
CREATE INDEX shop_requests_status ON shop_requests (status, created_at);
CREATE INDEX shop_requests_tenant ON shop_requests (tenant_id) WHERE tenant_id IS NOT NULL;

-- Operator actions on pre-tenant requests (there is no tenant audit_log yet).
CREATE TABLE operator_audit (
  id             TEXT PRIMARY KEY,
  action         TEXT NOT NULL CHECK (action IN ('shop_request_email_added','shop_request_email_verified','shop_request_email_manual','shop_request_approve','shop_request_reject','shop_request_reopen')),
  request_id     TEXT,
  tenant_id      TEXT,
  operator_email TEXT NOT NULL,
  reason         TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
  before_json    TEXT,
  after_json     TEXT,
  created_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX operator_audit_request ON operator_audit (request_id, created_at);
CREATE INDEX operator_audit_time ON operator_audit (created_at);
```

### 2.6 Public request status index (migration `0007_shop_requests_token.sql`)

```sql
-- The public request-status lookup is by random token; without this index every poll
-- scans the platform table.
CREATE INDEX shop_requests_token ON shop_requests (status_token_hash);
```


### 2.7 Expense reversal uniqueness (migration `0008_review_hardening.sql`)

```sql
-- One reversal row per expense. The client checks this optimistically, but two tills
-- (or two transactions in one push) must not be able to reverse the same expense twice.
-- A trigger (not a UNIQUE index) keeps the fix deployable when an older database already
-- contains duplicate reversals, which append-only rules forbid deleting.
CREATE TRIGGER expenses_one_reversal
BEFORE INSERT ON expenses
WHEN NEW.reverses_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM expenses e
    WHERE e.tenant_id = NEW.tenant_id AND e.reverses_id = NEW.reverses_id
  )
BEGIN
  SELECT RAISE(ABORT, 'expense already reversed');
END;
```

### 2.8 Refund udhaar guard (migration `0009_refund_udhaar_guard.sql`)

```sql
-- A refund's udhaar part can never exceed the sale's udhaar, even when two tills push
-- two refunds at the same moment. The Worker checks the same rule, but only SQLite can
-- make the check and the insert one atomic step. AFTER (not BEFORE) keeps the table's
-- own CHECK/UNIQUE errors as the first answer for malformed rows.
CREATE TRIGGER refunds_udhaar_guard
AFTER INSERT ON refunds
WHEN NEW.udhaar_part > 0
  AND COALESCE(
    (SELECT SUM(r.udhaar_part) FROM refunds r
      WHERE r.tenant_id = NEW.tenant_id AND r.sale_id = NEW.sale_id),
    0
  ) > COALESCE(
    (SELECT s.udhaar_amount FROM sales s
      WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.sale_id),
    0
  )
BEGIN
  SELECT RAISE(ABORT, 'refund udhaar exceeds sale udhaar');
END;
```

### 2.9 Seventh-review hardening (migration `0010_review_hardening.sql`)

```sql
-- Seventh-review hardening.
--
-- Bump the database marker with the Worker's SCHEMA_VERSION (apps/api/wrangler.jsonc).
UPDATE meta SET value = '2' WHERE key = 'schema_version';
--
-- 1. Snapshot the day-close informational totals so a reprint is immutable.
-- 2. Make the drawer period unique per device, including two concurrent first closes.
-- 3. Enforce append-only at the database level. The Worker already rejects updates and
--    deletes on ledger tables; these triggers also protect admin imports, cron paths and
--    future code. Deletes are allowed only while the shop is in maintenance (restore
--    purge) or deleting (tenant deletion), and only `sales.status` may change in place.

ALTER TABLE day_closes ADD COLUMN card_total INTEGER;
ALTER TABLE day_closes ADD COLUMN bank_total INTEGER;
ALTER TABLE day_closes ADD COLUMN udhaar_given INTEGER;
ALTER TABLE day_closes ADD COLUMN bills INTEGER;
ALTER TABLE day_closes ADD COLUMN refunds INTEGER;

-- A pre-0010 database could hold two closes for the same drawer period (two concurrent
-- first closes). The unique indexes below are the fix, but CREATE UNIQUE INDEX aborts on
-- an existing duplicate, which would block every later migration and the deploy. Keep one
-- deterministic survivor per key first: the earliest inserted row for each period_start,
-- then the earliest for each period_end. This is the only DELETE allowed here; the
-- append-only triggers are created later in this same migration.
DELETE FROM day_closes
WHERE rowid IN (
  SELECT d.rowid FROM day_closes d
  WHERE EXISTS (
    SELECT 1 FROM day_closes e
    WHERE e.tenant_id = d.tenant_id
      AND e.device_id = d.device_id
      AND e.period_start = d.period_start
      AND e.rowid < d.rowid
  )
);
DELETE FROM day_closes
WHERE rowid IN (
  SELECT d.rowid FROM day_closes d
  WHERE EXISTS (
    SELECT 1 FROM day_closes e
    WHERE e.tenant_id = d.tenant_id
      AND e.device_id = d.device_id
      AND e.period_end = d.period_end
      AND e.rowid < d.rowid
  )
);

DROP INDEX day_closes_device;
CREATE UNIQUE INDEX day_closes_device ON day_closes (tenant_id, device_id, period_end);
CREATE UNIQUE INDEX day_closes_device_start ON day_closes (tenant_id, device_id, period_start);

CREATE TRIGGER sales_append_only_update
BEFORE UPDATE OF tenant_id, id, invoice_no, invoice_seq, branch_id, device_id,
  staff_id, customer_id, business_date, created_at, line_count, items_qty_milli,
  gross_total, item_discount_total, subtotal, bill_discount_type,
  bill_discount_value, bill_discount, tax_rate_bp, tax, tax_inclusive, rounding,
  total, paid_total, udhaar_amount, cash_tendered, change_given, replaces_sale_id,
  note
ON sales
BEGIN
  SELECT RAISE(ABORT, 'sales is append-only');
END;

CREATE TRIGGER sales_append_only_delete
BEFORE DELETE ON sales
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'sales is append-only');
END;

CREATE TRIGGER sale_lines_append_only_update
BEFORE UPDATE ON sale_lines
BEGIN
  SELECT RAISE(ABORT, 'sale_lines is append-only');
END;
CREATE TRIGGER sale_lines_append_only_delete
BEFORE DELETE ON sale_lines
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'sale_lines is append-only');
END;

CREATE TRIGGER payments_append_only_update
BEFORE UPDATE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payments is append-only');
END;
CREATE TRIGGER payments_append_only_delete
BEFORE DELETE ON payments
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'payments is append-only');
END;

CREATE TRIGGER refunds_append_only_update
BEFORE UPDATE ON refunds
BEGIN
  SELECT RAISE(ABORT, 'refunds is append-only');
END;
CREATE TRIGGER refunds_append_only_delete
BEFORE DELETE ON refunds
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'refunds is append-only');
END;

CREATE TRIGGER refund_lines_append_only_update
BEFORE UPDATE ON refund_lines
BEGIN
  SELECT RAISE(ABORT, 'refund_lines is append-only');
END;
CREATE TRIGGER refund_lines_append_only_delete
BEFORE DELETE ON refund_lines
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'refund_lines is append-only');
END;

CREATE TRIGGER sale_voids_append_only_update
BEFORE UPDATE ON sale_voids
BEGIN
  SELECT RAISE(ABORT, 'sale_voids is append-only');
END;
CREATE TRIGGER sale_voids_append_only_delete
BEFORE DELETE ON sale_voids
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'sale_voids is append-only');
END;

CREATE TRIGGER ledger_entries_append_only_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;
CREATE TRIGGER ledger_entries_append_only_delete
BEFORE DELETE ON ledger_entries
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;

CREATE TRIGGER stock_movements_append_only_update
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;
CREATE TRIGGER stock_movements_append_only_delete
BEFORE DELETE ON stock_movements
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'stock_movements is append-only');
END;

CREATE TRIGGER purchases_append_only_update
BEFORE UPDATE ON purchases
BEGIN
  SELECT RAISE(ABORT, 'purchases is append-only');
END;
CREATE TRIGGER purchases_append_only_delete
BEFORE DELETE ON purchases
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'purchases is append-only');
END;

CREATE TRIGGER purchase_lines_append_only_update
BEFORE UPDATE ON purchase_lines
BEGIN
  SELECT RAISE(ABORT, 'purchase_lines is append-only');
END;
CREATE TRIGGER purchase_lines_append_only_delete
BEFORE DELETE ON purchase_lines
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'purchase_lines is append-only');
END;

CREATE TRIGGER supplier_returns_append_only_update
BEFORE UPDATE ON supplier_returns
BEGIN
  SELECT RAISE(ABORT, 'supplier_returns is append-only');
END;
CREATE TRIGGER supplier_returns_append_only_delete
BEFORE DELETE ON supplier_returns
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'supplier_returns is append-only');
END;

CREATE TRIGGER supplier_return_lines_append_only_update
BEFORE UPDATE ON supplier_return_lines
BEGIN
  SELECT RAISE(ABORT, 'supplier_return_lines is append-only');
END;
CREATE TRIGGER supplier_return_lines_append_only_delete
BEFORE DELETE ON supplier_return_lines
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'supplier_return_lines is append-only');
END;

CREATE TRIGGER expenses_append_only_update
BEFORE UPDATE ON expenses
BEGIN
  SELECT RAISE(ABORT, 'expenses is append-only');
END;
CREATE TRIGGER expenses_append_only_delete
BEFORE DELETE ON expenses
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'expenses is append-only');
END;

CREATE TRIGGER cash_moves_append_only_update
BEFORE UPDATE ON cash_moves
BEGIN
  SELECT RAISE(ABORT, 'cash_moves is append-only');
END;
CREATE TRIGGER cash_moves_append_only_delete
BEFORE DELETE ON cash_moves
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'cash_moves is append-only');
END;

CREATE TRIGGER day_closes_append_only_update
BEFORE UPDATE ON day_closes
BEGIN
  SELECT RAISE(ABORT, 'day_closes is append-only');
END;
CREATE TRIGGER day_closes_append_only_delete
BEFORE DELETE ON day_closes
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'day_closes is append-only');
END;

CREATE TRIGGER audit_log_append_only_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
CREATE TRIGGER audit_log_append_only_delete
BEFORE DELETE ON audit_log
WHEN (SELECT status FROM tenants WHERE id = OLD.tenant_id)
  NOT IN ('maintenance', 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
```

### 2.10 Day-close index coverage (migration `0011_perf_close_indexes.sql`)

The push lookups for `day_closes` filter payments, cash moves and expenses by
`(tenant_id, device_id, created_at)`. Without a matching index SQLite uses only the
tenant prefix, so a year-old shop scans every row it has ever written during each close.
These are additive indexes and do not change `SCHEMA_VERSION`.

```sql
-- T-062 follow-up: selective indexes for the day-close push. Additive only.
--
-- applyOps reads the payments, cash moves and expenses of each closing device between
-- period_start and period_end. Without these indexes SQLite scans every row the tenant
-- has ever written for those tables (only the tenant_id prefix is usable), which grows
-- with the shop's age and burns the D1 rows-read budget on every close.
CREATE INDEX payments_device_created ON payments (tenant_id, device_id, created_at);
CREATE INDEX expenses_device_created ON expenses (tenant_id, device_id, created_at);
CREATE INDEX cash_moves_device_created ON cash_moves (tenant_id, device_id, created_at);
```

### 2.11 Verifier and time-zone guards (migration `0012_verifier_guards.sql`)

A staff row with an unusable PIN verifier (empty salt, zero PBKDF2 iterations) used to
make PIN unlock throw on every till, and an unknown `shop.timezone` made the sale write
throw. `packages/core` now treats a bad verifier as a wrong PIN, falls back to
`Asia/Karachi` for an unknown zone, and the push/import paths validate both. These
triggers keep a row written by any other path (operator import, manual SQL) usable.

```sql
-- Verifier and time-zone guards (review hardening).
--
-- A malformed staff verifier (empty salt, zero PBKDF2 iterations) used to make every
-- PIN unlock throw on every till of the shop, and an unknown `shop.timezone` made
-- `Intl.DateTimeFormat` throw inside the sale write. The app now treats a bad verifier as
-- a wrong PIN and falls back to the documented time zone, and the push/import paths
-- validate both. These triggers keep a server-owned row from ever storing a value that
-- the tills cannot use, including through an operator import.
CREATE TRIGGER staff_pin_shape_insert
BEFORE INSERT ON staff
WHEN NEW.pin_iterations < 100000
  OR NEW.pin_iterations > 1000000
  OR length(NEW.pin_salt) < 16
  OR length(NEW.pin_salt) > 200
  OR length(NEW.pin_hash) < 16
  OR length(NEW.pin_hash) > 200
BEGIN
  SELECT RAISE(ABORT, 'staff pin verifier is malformed');
END;

CREATE TRIGGER staff_pin_shape_update
BEFORE UPDATE OF pin_hash, pin_salt, pin_iterations ON staff
WHEN NEW.pin_iterations < 100000
  OR NEW.pin_iterations > 1000000
  OR length(NEW.pin_salt) < 16
  OR length(NEW.pin_salt) > 200
  OR length(NEW.pin_hash) < 16
  OR length(NEW.pin_hash) > 200
BEGIN
  SELECT RAISE(ABORT, 'staff pin verifier is malformed');
END;

CREATE TRIGGER shop_timezone_shape_insert
BEFORE INSERT ON shop
WHEN length(NEW.timezone) < 1 OR length(NEW.timezone) > 64
BEGIN
  SELECT RAISE(ABORT, 'shop timezone is malformed');
END;

CREATE TRIGGER shop_timezone_shape_update
BEFORE UPDATE OF timezone ON shop
WHEN length(NEW.timezone) < 1 OR length(NEW.timezone) > 64
BEGIN
  SELECT RAISE(ABORT, 'shop timezone is malformed');
END;
```

### 2.12 Server-side stock cache (migration `0013_product_stock_cache.sql`)

`applyOps` used to compute each referenced product's on-hand by summing its entire
`stock_movements` history and scan it again for `cost_changed_at`, on every push. Those
values grow with the shop's age, not with the bill. The two cache columns are
server-owned (hidden from pull, snapshot and export) and updated atomically with each
movement; the migration backfills them once. Additive only; `SCHEMA_VERSION` is unchanged.

```sql
-- Performance: server-side stock cache for push lookups (D-225). Additive only.
--
-- applyOps fills a CostState per referenced product on every push. It used to compute
-- on_hand by summing the product's entire stock_movements history and cost_changed_at by
-- scanning it again; both grow with the shop's age. These two columns are a server-only
-- cache, updated atomically with each movement and never pulled by tills.
ALTER TABLE products ADD COLUMN on_hand_milli INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN cost_changed_at INTEGER NOT NULL DEFAULT 0;
UPDATE products
SET
  on_hand_milli = COALESCE((
    SELECT SUM(m.qty_delta_milli)
    FROM stock_movements m
    WHERE m.tenant_id = products.tenant_id AND m.product_id = products.id
  ), 0),
  cost_changed_at = COALESCE((
    SELECT MAX(m.created_at)
    FROM stock_movements m
    WHERE m.tenant_id = products.tenant_id AND m.product_id = products.id
      AND m.qty_delta_milli > 0 AND m.unit_cost IS NOT NULL
  ), 0);

-- Keep the cache correct for every insert path, including operator imports and tests
-- that write stock_movements directly. The app still computes avg_cost/last_cost in the
-- same batch; this trigger only touches the two derived columns and never bumps rev.
CREATE TRIGGER products_stock_after_movement
AFTER INSERT ON stock_movements
BEGIN
  UPDATE products
  SET
    on_hand_milli = on_hand_milli + NEW.qty_delta_milli,
    cost_changed_at = CASE
      WHEN NEW.qty_delta_milli > 0 AND NEW.unit_cost IS NOT NULL
        THEN MAX(cost_changed_at, NEW.created_at)
      ELSE cost_changed_at
    END
  WHERE tenant_id = NEW.tenant_id AND id = NEW.product_id;
END;
```

The trigger runs once per inserted movement, including operator imports and the
server-authored repair rows. It is kept for correctness across every insert path; its
three `UPDATE products` writes per reference bill are counted in the 0028 budget
measurements (D-278 leaves the trigger in place rather than duplicating the cache update
in each call site).

### 2.13 Tenant file-usage accounting (migration `0014_tenant_file_usage.sql`)

Every upload used to list the whole `t/<tenant>/` R2 prefix to sum object sizes before
checking the 1 GB cap: one Class A list per upload, slower as the photo library grows.
`file_bytes` is now reserved atomically with a conditional `UPDATE` before the R2 PUT and
released if the PUT fails; `files_initialized` makes the one-time prefix backfill run once
per shop. File GC and tenant deletion reset the counter from their authoritative listing.
Additive only; `SCHEMA_VERSION` is unchanged.

```sql
-- R2 usage accounting per shop (D-226). Additive only.
--
-- Every upload used to list the whole `t/<tenant>/` prefix to sum object sizes before
-- checking the 1 GB cap. That cost one R2 Class A list per upload and got slower as the
-- shop's photo library grew. `file_bytes` is now reserved atomically with a conditional
-- UPDATE; `files_initialized` makes the one-time backfill run only once per shop.
ALTER TABLE tenants ADD COLUMN file_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN files_initialized INTEGER NOT NULL DEFAULT 0;
```

### 2.14 Sale-line business date (migration `0015_sale_line_business_date.sql`)

Home's today summary, the 30-day best sellers, Sales search and product detail need the
lines of a business-date range. Without a date on `sale_lines`, those reads fell back to
every line the shop had ever written once a range crossed 100 bills. The column is derived
from the parent sale; the till sends it and `applyOps` fills it from the parent when an
older client omits it. The one-time backfill temporarily drops the append-only UPDATE
trigger, updates every line from its sale, and recreates the trigger before the migration
ends. D1 only stores the column (the server never queries lines by product or date); the till's Dexie V7 index serves the range and product screens. The migration also drops the unused `sale_lines_product` D1 index. Additive only; `SCHEMA_VERSION` is unchanged.

```sql
-- D-228: denormalise the sale's business date onto each sale line.
--
-- The till's Sales list, Home summary, 30-day best sellers and product detail all
-- needed lines for a business-date range, but sale_lines had no date column. They
-- therefore scanned every line the shop had ever written once a range crossed 100
-- bills. The column is derived from the parent sale; clients send it, and applyOps
-- fills it from the parent when an older client omits it.
--
-- sale_lines is append-only. The one-time backfill needs the UPDATE trigger out of
-- the way; it is recreated immediately below, before the migration ends.
DROP TRIGGER IF EXISTS sale_lines_append_only_update;

ALTER TABLE sale_lines ADD COLUMN business_date TEXT NOT NULL DEFAULT '';

UPDATE sale_lines
SET business_date = (
  SELECT s.business_date
  FROM sales s
  WHERE s.tenant_id = sale_lines.tenant_id AND s.id = sale_lines.sale_id
);

CREATE TRIGGER sale_lines_append_only_update
BEFORE UPDATE ON sale_lines
BEGIN
  SELECT RAISE(ABORT, 'sale_lines is append-only');
END;

-- The server never queries sale_lines by product or date (the till does, in Dexie);
-- drop the unused product index and keep D1 writes low. The local V7 index
-- [product_id+business_date] serves the product screen.
DROP INDEX IF EXISTS sale_lines_product;
```


### 2.15 Change-log prune index (migration `0016_change_log_prune_index.sql`)

The nightly prune groups old change rows by tenant and takes `MAX(seq)`. The old
`change_log_at` index still had to look up each row's tenant and seq. A covering
`(at, tenant_id, seq)` index answers the group and maximum from the index alone.
Additive only; `SCHEMA_VERSION` is unchanged.

```sql
-- D-228: covering index for the nightly change_log prune.
--
-- The prune takes `MAX(seq)` for one tenant and `at < cutoff`. A tenant-leading
-- covering index answers that from the index alone; the old `change_log_at` index
-- still had to look up each row's tenant and seq. Additive only; SCHEMA_VERSION is
-- unchanged.
CREATE INDEX change_log_prune ON change_log (tenant_id, at, seq);
```

### 2.16 Bundles (migration `0017_bundles.sql`)

Adds the bundle product kind, the fixed recipe table, and the bundle metadata on sale lines. This is a column/wire change: bump `SCHEMA_VERSION` and `CLIENT_SCHEMA_VERSION`; the Dexie schema goes to **V8**. The migration does **not** rebuild `sale_lines` (SQLite cannot add a composite FK with `ALTER TABLE`, and rebuilding a parent referenced by `refund_lines` needs foreign keys disabled); the server validates `sale_lines.bundle_id` against the tenant's products and the bundle group in `checkOp`. The isolation suite still covers the column.

```sql
-- 0017_bundles.sql
--
-- A bundle is a product row with kind='bundle', track_stock=0 and a fixed recipe.
-- The sale is expanded into ordinary component sale_lines; the bundle product
-- never becomes a sale line and never gets a stock movement.
ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'simple'
  CHECK (kind IN ('simple','bundle'));
CREATE INDEX products_kind ON products (tenant_id, kind);

CREATE TABLE bundle_items (
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  id                  TEXT NOT NULL,
  bundle_id           TEXT NOT NULL,
  component_product_id TEXT NOT NULL,
  qty_milli           INTEGER NOT NULL CHECK (qty_milli > 0),
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  rev                 INTEGER NOT NULL DEFAULT 1,
  updated_by          TEXT,
  FOREIGN KEY (tenant_id, bundle_id) REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, component_product_id) REFERENCES products(tenant_id, id),
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE UNIQUE INDEX bundle_items_component
  ON bundle_items (tenant_id, bundle_id, component_product_id)
  WHERE deleted_at IS NULL;
CREATE INDEX bundle_items_lookup
  ON bundle_items (tenant_id, component_product_id)
  WHERE deleted_at IS NULL;

-- sale_lines: bundle metadata. All null for a normal or quick-sale line.
-- The all-or-none group, qty identity and group totals are checked by checkOp;
-- a composite FK on bundle_id is deliberately not added (see the note above).
ALTER TABLE sale_lines ADD COLUMN bundle_id TEXT;
ALTER TABLE sale_lines ADD COLUMN bundle_group TEXT;
ALTER TABLE sale_lines ADD COLUMN bundle_name TEXT
  CHECK (bundle_name IS NULL OR length(bundle_name) BETWEEN 1 AND 80);
ALTER TABLE sale_lines ADD COLUMN bundle_qty INTEGER
  CHECK (bundle_qty IS NULL OR bundle_qty > 0);
ALTER TABLE sale_lines ADD COLUMN bundle_price INTEGER
  CHECK (bundle_price IS NULL OR bundle_price >= 0);
ALTER TABLE sale_lines ADD COLUMN bundle_component_qty_milli INTEGER
  CHECK (bundle_component_qty_milli IS NULL OR bundle_component_qty_milli > 0);

UPDATE meta SET value = '4' WHERE key = 'schema_version';
```

**Rules the migration cannot express in D1** (enforced by `checkOp` and the product form):

- `products.kind = 'bundle'` ⇒ `track_stock = 0`; a bundle has no `avg_cost`/`last_cost` of its own, no opening stock, no stock adjustment and no low-stock alert.
- `bundle_items.bundle_id` is a bundle product (`kind='bundle'`); `component_product_id` is a simple product (`kind='simple'`), not the bundle itself and not another bundle (no nesting); components must exist and not be soft-deleted.
- A bundle has 1–20 active `bundle_items`; duplicate component ids are merged into one row with the summed quantity.
- A product used by an active bundle cannot be deleted or changed to `kind='bundle'` until the recipe is removed.
- Sale-line group: all seven `bundle_*` columns are set or all are null; `bundle_qty` is a positive whole number; `bundle_id <> product_id`; `qty_milli = bundle_component_qty_milli × bundle_qty`; every line in a `bundle_group` shares `bundle_id`, `bundle_group`, `bundle_name`, `bundle_qty`, `bundle_price` and `bundle_discount`; `Σ net = (bundle_price − bundle_discount) × bundle_qty`; the component set/quantity matches the current recipe when the sale is fresh (or the replaced sale's snapshot on a reissue).
- A component line's price may be below the component's shelf price without `catalog.edit`/a price override, because it is derived by `priceBundle()` ([07 §3.4](07-money-rules.md#34-bundles-v11)). The group total check is the guard.
- `bundle_name` is a snapshot for receipts/reprints; renaming or deleting the bundle later never changes a saved sale.
- `bundle_price` is the pre-discount whole-bundle price; `bundle_discount` is the per-bundle manual discount. The discount is part of the staff discount limit and "You saved"; it is not a price override.

`bundle_items` follows the master-row soft-delete rule; a recipe edit upserts/soft-deletes item rows with `base_rev` like any master row. The bundle product's price edit writes `price_change`; a recipe edit writes `bundle_change` ([05 §7](05-auth-and-roles.md#7-audit-log-actions)).

### 2.17 Bundle discount (migration `0018_bundle_discount.sql`)

```sql
-- 0018_bundle_discount.sql
--
-- A bundle can carry a manual discount on the whole-bundle price. The sale lines keep
-- the pre-discount bundle price in `bundle_price` and the per-bundle discount here, so
-- the discount can be checked against the staff limit and shown as "You saved".
ALTER TABLE sale_lines ADD COLUMN bundle_discount INTEGER
  CHECK (bundle_discount IS NULL OR bundle_discount >= 0);

UPDATE meta SET value = '5' WHERE key = 'schema_version';
```

The column is repeated on every component line of the group like the other bundle
snapshot fields. `bundle_discount` is per bundle, so the group's discount total is
`bundle_discount × bundle_qty`; it must not exceed `bundle_price`. The sale check
includes it once per `bundle_group` in `manual_discount` and validates
`Σ net = (bundle_price − bundle_discount) × bundle_qty`.

### 2.18 Sale bundle discount total (migration `0019_sale_bundle_discount_total.sql`)

```sql
-- 0019_sale_bundle_discount_total.sql
--
-- Denormalise the whole-bundle discount total on the bill so reports and CSV exports
-- do not have to re-read every sale line to show the discount.
ALTER TABLE sales ADD COLUMN bundle_discount_total INTEGER NOT NULL DEFAULT 0
  CHECK (bundle_discount_total >= 0);

UPDATE meta SET value = '6' WHERE key = 'schema_version';
```

`bundle_discount_total` is the sum of every bundle group's
`bundle_discount × bundle_qty`. It is part of the manual discount shown in reports
and "You saved"; it is not part of `item_discount_total`, which remains the sum of
component line residual discounts.

### 2.19 Hot-path indexes (migration `0020_perf_indexes.sql`)

```sql
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
```

These are the refund/void movement lookup, the purchase-payment lookup, the
branch invoice lookup used by device-code allocation, and the operator status
history. All lead with `tenant_id` (D-231).

### 2.20 Unused index cleanup (migration `0021_drop_unused_indexes.sql`)

```sql
-- D-231: drop indexes no production query in apps/api/src uses. D1 counts index
-- entries as rows written, and the 150-bill budget measured ~127 rows/bill with
-- these present; removing them recovers about a quarter of the daily write budget.
--
-- The client has its own Dexie indexes for the same columns; this only changes the
-- server schema. Keep every index that a query in routes/, sync/, platform/ or cron/
-- actually names (see apps/api/test/perf.test.ts HOT_QUERIES).
DROP INDEX change_log_row;
DROP INDEX change_log_at;
DROP INDEX applied_ops_device;
DROP INDEX sales_date;
DROP INDEX sales_customer;
DROP INDEX sales_device_seq;
DROP INDEX payments_date;
DROP INDEX payments_party;
DROP INDEX refunds_date;
DROP INDEX expenses_date;
DROP INDEX stock_movements_product;
DROP INDEX products_category;
DROP INDEX product_barcodes_product;
DROP INDEX customers_phone;
DROP INDEX promises_due;
DROP INDEX audit_log_entity;
```

D1 counts index entries as rows written. These indexes serve no production SQL
in `apps/api/src` (the client keeps its own Dexie indexes); dropping them
recovers about a quarter of the daily write budget (D-231).

### 2.21 Hide the shop name on receipts (migration `0022_show_shop_name_on_receipt.sql`)

```sql
-- Some shops put the shop name inside their logo. Allow the receipt header to omit
-- the separate name line while keeping the logo (screens/17, D-232).
ALTER TABLE shop ADD COLUMN show_shop_name_on_receipt INTEGER NOT NULL DEFAULT 1
  CHECK (show_shop_name_on_receipt IN (0,1));
```

Default `1` keeps every existing receipt unchanged. When `0`, the shared receipt
header (`pushShopHeader`) skips the shop-name line while still printing the logo,
address, phone and tax numbers; the WhatsApp receipt text skips the name too. It is
a shop-level setting in Settings → Shop profile & receipt and does not change sales.
The schema marker bump lives in migration `0023` so a database that already applied
`0022` still advances. `SCHEMA_VERSION` and `CLIENT_SCHEMA_VERSION` are both 7; the
Worker's bundle pull gate stays at schema 5 because it marks when bundles shipped,
not the current schema.

### 2.22 Schema marker after the shop-name column (migration `0023_schema_version_7.sql`)

```sql
-- 0022 added a shop column after the 1.1.0 schema bump. Set the database marker to the
-- Worker's SCHEMA_VERSION 7; a fresh database runs this right after 0022 (review L9).
UPDATE meta SET value = '7' WHERE key = 'schema_version';
```

A separate migration is deliberate: editing `0022` would not update a database where
it was already applied. Fresh databases run `0022` (the marker stays at 6) and then
`0023` (7).

### 2.23 Backfill catalogue cost into product average cost (migration `0024_backfill_product_avg_cost.sql`)

```sql
-- Products created with a catalogue cost but no stock movement kept `avg_cost = 0` on
-- the server (the column is server-managed and was only derived from movements). That
-- made a sale before the first costed movement look like a zero-cost sale after a pull.
-- Initialise those rows from the catalogue cost; rows with movements keep their derived
-- weighted average. Additive data repair only: no column or wire change.
--
-- Historical note: 0021 had already dropped `stock_movements_product`, so this one-time
-- NOT EXISTS scan was unindexed. It is safe because it runs exactly once before the
-- table can grow large; do not copy the pattern into a new backfill without restoring
-- an index or paging by product id.
UPDATE products
SET avg_cost = last_cost
WHERE avg_cost = 0
  AND last_cost > 0
  AND NOT EXISTS (
    SELECT 1
    FROM stock_movements sm
    WHERE sm.tenant_id = products.tenant_id
      AND sm.product_id = products.id
  );
```

Data-only migration: `SCHEMA_VERSION` stays 7. New products are initialised at insert
by `applyOps`; this repairs rows created before that change.

### 2.24 Show or hide the logo on receipts (migration `0025_show_logo_on_receipt.sql`)

```sql
-- Shops can hide the logo from printed receipts without removing the uploaded image
-- (screens/17). Default 1 keeps existing and new receipts unchanged.
ALTER TABLE shop ADD COLUMN show_logo_on_receipt INTEGER NOT NULL DEFAULT 1
  CHECK (show_logo_on_receipt IN (0,1));

-- New wire field: the till and Worker must agree on schema 8.
UPDATE meta SET value = '8' WHERE key = 'schema_version';
```

Default `1` keeps every existing receipt unchanged. When `0`, the shared receipt
header (`pushShopHeader`) omits its logo block while keeping the shop name,
address, phone and tax numbers; the uploaded logo and `kv.logo_bitmap` stay in
place, so turning it back on needs no re-upload. It is a shop-level setting in
Settings → Shop profile & receipt. This is a column/wire change, so
`SCHEMA_VERSION` and `CLIENT_SCHEMA_VERSION` both become 8; the Dexie schema is
unchanged because `shop` stores every column without an index on this one.

### 2.25 Append-only sales trigger includes the bundle discount (migration `0026_sales_append_only_bundle_discount.sql`)

```sql
-- 0026_sales_append_only_bundle_discount.sql
--
-- 0019 added `sales.bundle_discount_total` with ALTER TABLE, but the append-only
-- trigger from 0010 lists its protected columns explicitly and was not rebuilt, so a
-- direct UPDATE of the new column slipped past the database-level guard. Recreate the
-- trigger with the full column list. Trigger-only change: the wire schema is unchanged.
DROP TRIGGER sales_append_only_update;

CREATE TRIGGER sales_append_only_update
BEFORE UPDATE OF tenant_id, id, invoice_no, invoice_seq, branch_id, device_id,
  staff_id, customer_id, business_date, created_at, line_count, items_qty_milli,
  gross_total, item_discount_total, subtotal, bill_discount_type,
  bill_discount_value, bill_discount, tax_rate_bp, tax, tax_inclusive, rounding,
  total, paid_total, udhaar_amount, cash_tendered, change_given, replaces_sale_id,
  bundle_discount_total, note
ON sales
BEGIN
  SELECT RAISE(ABORT, 'sales is append-only');
END;
```

Trigger-only migration: `SCHEMA_VERSION` stays 8. `sales.status` remains the only
mutable column; every other column, including `bundle_discount_total`, is protected
by the database as well as the Worker.

### 2.26 Self-reference index for restore purge and tenant deletion (migration `0027_sales_replaces_index.sql`)

```sql
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
```

The partial index covers both the operator purge's "replacement bills first" pass and
the nightly tenant delete. Normal bills write no index entry because their
`replaces_sale_id` is NULL.

### 2.27 Device-code registry and prune budget index (migration `0028_device_codes_and_admin_indexes.sql`)

```sql
-- D-269 / fifth performance review P1: stop allocating device codes by fetching
-- every invoice number in the branch. The registry is server-only (never pulled by
-- tills) and is backfilled once from current devices, their code history and the
-- bills that already carry a code. Additive table + indexes; SCHEMA_VERSION stays 8.
CREATE TABLE branch_device_codes (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  branch_id   TEXT NOT NULL,
  device_code TEXT NOT NULL,
  PRIMARY KEY (tenant_id, branch_id, device_code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
) STRICT;

-- Current devices.
INSERT OR IGNORE INTO branch_device_codes (tenant_id, branch_id, device_code)
SELECT tenant_id, branch_id, device_code FROM devices;

-- Codes a device kept after a branch move (comma-separated history).
WITH RECURSIVE split(tenant_id, branch_id, code, rest) AS (
  SELECT tenant_id, branch_id, '', device_code_history || ','
  FROM devices
  WHERE device_code_history <> ''
  UNION ALL
  SELECT tenant_id, branch_id,
    substr(rest, 1, instr(rest, ',') - 1),
    substr(rest, instr(rest, ',') + 1)
  FROM split
  WHERE rest <> ''
)
INSERT OR IGNORE INTO branch_device_codes (tenant_id, branch_id, device_code)
SELECT tenant_id, branch_id, code
FROM split
WHERE code <> '' AND length(code) BETWEEN 1 AND 3
  AND code NOT GLOB '*[^A-Z]*';

-- Codes only visible in existing invoice numbers (a device moved away and its
-- history predates 0005). Parse '<prefix>-<code>-<seq>'.
WITH parsed AS (
  SELECT tenant_id, branch_id, invoice_no, instr(invoice_no, '-') AS h1
  FROM sales
  WHERE instr(invoice_no, '-') > 1
),
split AS (
  SELECT tenant_id, branch_id, invoice_no, h1,
    substr(invoice_no, h1 + 1) AS rest,
    instr(substr(invoice_no, h1 + 1), '-') AS h2
  FROM parsed
  WHERE h1 > 1
)
INSERT OR IGNORE INTO branch_device_codes (tenant_id, branch_id, device_code)
SELECT tenant_id, branch_id, substr(rest, 1, h2 - 1)
FROM split
WHERE h2 > 1
  AND length(substr(invoice_no, 1, h1 - 1)) BETWEEN 1 AND 6
  AND substr(invoice_no, 1, h1 - 1) NOT GLOB '*[^A-Z0-9]*'
  AND length(substr(rest, 1, h2 - 1)) BETWEEN 1 AND 3
  AND substr(rest, 1, h2 - 1) NOT GLOB '*[^A-Z]*'
  AND substr(rest, h2 + 1) <> ''
  AND substr(rest, h2 + 1) NOT GLOB '*[^0-9]*';

-- The registry replaces the branch-invoice lookup used by device enrolment.
DROP INDEX sales_branch_invoice;

-- The nightly prune sums today's writes across shops before it budgets its deletes.
CREATE INDEX tenant_usage_day ON tenant_usage (day);
```

`branch_device_codes` is server-owned: it is not in `SNAPSHOT_TABLES` and is never
pulled by a till. Restore purge keeps it (like devices and enrolment codes); tenant
deletion removes it. The invoice backfill runs once; enrolment only reads the
branch's few codes.

### 2.28 D1 write/read capacity (migration `0029_d1_write_capacity.sql`)

```sql
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
```

`change_log_watermarks` is server-only. The nightly prune records each tenant's
`MAX(seq)` for the UTC day at the start of each run and uses that tenant's latest mark at
or before the 30-day cutoff as its deletion ceiling. Rows written after the mark stay
until the next run, so retention is 30 days plus at most one day.

## 3. Dexie schema (till)

`packages/db/src/dexie.ts`. Same table and column names as D1, **without `tenant_id`**: each tenant has its own Dexie database named **`bikri-<tenant_id>`**, so a till's local data can only ever be one shop's (D-073). `localStorage['bikri.active_tenant']` (non-secret) names the database to open; before enrolment there is none. Index strings list only indexed fields; Dexie stores every column.

```ts
// Example only — exact index strings to implement.
export const DEXIE_SCHEMA_V12 = {
  // master
  shop: 'id',
  branches: 'id, deleted_at',
  devices: 'id, branch_id',
  staff: 'id, active, deleted_at',
  categories: 'id, sort_order, deleted_at',
  products: 'id, sku, category_id, deleted_at, track_stock', // V9 track_stock; V12 drops name_en/updated_at/kind (filtered in memory)
  bundle_items: 'id, bundle_id, component_product_id, deleted_at', // V8; fixed recipe; repository checks one active row per (bundle, component), like barcodes
  product_barcodes: 'id, barcode, product_id, deleted_at',   // NOT unique in Dexie: D1 uniqueness ignores soft-deleted rows; the repository checks "no other non-deleted row" for sku and barcode
  customers: 'id, phone, credit_limit', // V12 drops name/deleted_at (filtered in memory)
  suppliers: 'id',
  expense_categories: 'id, code, sort_order',
  promises: 'id, customer_id, [status+promised_on]',
  sync_conflicts: 'id, resolution',   // pulled read-only; V12 drops row_id/at
  // ledger
  sales: 'id, &invoice_no, business_date, created_at, [device_id+invoice_seq], status',
  sale_lines: 'id, sale_id, business_date, bundle_id, [product_id+business_date], [bundle_id+business_date]', // V7 date/product; V8 bundle; V11 bundle+date; V12 drops standalone product_id

  payments: 'id, business_date, sale_id, [party_type+party_id], [device_id+created_at], created_at', // V7 adds created_at for the promise refresh
  refunds: 'id, sale_id, business_date, [device_id+created_at]',
  refund_lines: 'id, refund_id, sale_line_id, business_date', // V10 adds the refund's business date (till-only; reports count refunds on their own date)
  sale_voids: 'id, &sale_id, created_at, business_date',
  ledger_entries: 'id, [party_type+party_id+created_at], [party_type+party_id+business_date+created_at], created_at', // V7 date page; V11 created_at; V12 drops source_id
  stock_movements: 'id, [product_id+created_at], [ref_type+ref_id], business_date', // V4 adds [ref_type+ref_id] (refund/void restock)
  purchases: 'id, [supplier_id+created_at], business_date',
  purchase_lines: 'id, purchase_id',
  supplier_returns: 'id, [supplier_id+created_at], purchase_id, business_date',
  supplier_return_lines: 'id, return_id, purchase_line_id',
  expenses: 'id, business_date, [device_id+created_at], reverses_id', // V3 reverses_id; V12 drops category_id
  cash_moves: 'id, [device_id+created_at]',
  day_closes: 'id, [device_id+period_end], business_date',
  audit_log: 'id, [entity+entity_id], created_at',
  // local-only
  outbox: '++seq, &op_id, [status+seq], created_at, [tbl+row_id]', // V5 status+seq; V12 drops standalone status
  kv: 'key',
  carts: 'id',                    // up to 3 open carts: 'c1','c2','c3'
  held_bills: 'id, created_at',
  file_queue: '++id, status, created_at, [status+created_at]', // V12 adds the retention index
  print_jobs: 'id, sale_id, refund_id, day_close_id, supplier_return_id, [status+created_at], created_at', // V3 document ids; V6 compound; V12 drops standalone status
  stock_levels: 'product_id',     // { product_id, on_hand_milli }
  party_balances: '[party_type+party_id]', // { party_type, party_id, balance, last_activity_at, oldest_unpaid_at, last_payment_at? } (V11 last payment)
  pull_shadow: '[tbl+id]',        // { row, source: 'local'|'server' } restore point or skipped server row (03 §4.2)
};
```

**Dexie V8 (bundles)** adds the `products.kind` index, the `bundle_items` table and the `sale_lines.bundle_id` index. The upgrade backfills `kind='simple'` on local product rows that lack it (an indexed field must exist); existing `sale_lines` get null bundle fields, and held carts keep their current lines. No server data is rewritten. A till that has never pulled a bundle has an empty `bundle_items` table.

**Dexie V9 (D-231)** only adds indexes: `products.track_stock`, `customers.credit_limit` and `sync_conflicts.resolution` (Home's attention probes). IndexedDB backfills the entries from the stored rows; no data is rewritten. The client filter/statement changes in the same decision do not change the schema.

**Dexie V10 (D-274)** denormalises the refund's `business_date` onto `refund_lines` as a **till-only** column: it is not in D1, is stripped from pushed ops (`LOCAL_ONLY_COLUMNS`), and is re-derived from the refund when a server row is merged. The upgrade backfills missing dates from the local `refunds` table, the same streaming pattern as V7's sale lines. Reports then read one date range instead of turning a busy refund list above the old key threshold into a full scan of every refund line the shop ever wrote.

**Dexie V11 (D-277)** adds `sale_lines.[bundle_id+business_date]` so a bundle's 14-day chart reads only its window, plus `created_at` indexes on the ledger tables restore recovery bounds by the restore point. The upgrade backfills `party_balances.last_payment_at` from the matching `ledger_entries` payment rows for the chase list. Local-only indexes/columns; D1 is unchanged.

**Dexie V12 (D-279)** removes indexes no query uses (and three prefix indexes already covered by a compound one), adds `file_queue.[status+created_at]` and `sale_voids.business_date`, and keeps only the range indexes the remaining scans need. The upgrade only adds/drops indexes; IndexedDB rebuilds them from stored rows. No server or wire change.

### 3.1 Local-only tables

| Table | Shape | Purpose |
|---|---|---|
| `outbox` | `{ seq, op_id, tx_id, tbl, kind, row_id, row, base_rev?, changed_fields?, created_at, status: 'pending'|'sending'|'failed', attempts, last_error? }` | Ops waiting to be pushed; acknowledged entries are deleted ([03-sync §3](03-sync.md#3-outbox)) |
| `kv` | `{ key, value }` | `tenant` (id, display_name; from enrolment and `/api/me`), `device` (id, name, code, branch_id, is_admin), `device_token`, `invoice_seq` (last issued number, never decreases, 03 §5), `pull_cursor`, `restore_epoch`, `last_push_at`, `last_pull_at`, `printer` (shape in [06 §8](06-printing.md#8-printer-setup-and-test-print-per-device)), `logo_bitmap`, `ui.prefs` (device display: theme, text size, sounds, auto-lock and `privacyMode`), `language`, `locked_staff_id`, `pin_failures` (05 §4), `stock_count_draft` (screens/09), `setup_draft` (screens/01), `label` (label size and options, [screens/20](screens/20-barcode-labels.md)), `snapshot_state` (resumable snapshot progress, 03 §4.3), `last_full_sync_at`, `poll_after_ms` (from the server, 13 §6), `tenant_status` (`{ status, since, learned_at }` from `/api/me`, pull and push responses; `read_only` puts the till in read-only mode, 13 §7.2), `support` (`{ until, reason }` while operator support access is active, 13 §7.5) |
| `carts` | `{ id: 'c1'|'c2'|'c3', customer_id?, lines: CartLine[], bill_discount?: {type, value}, note, updated_at }` | Open carts, survive reload |
| `held_bills` | same as cart + `{ held_at, held_by, label }` | Parked bills |
| `file_queue` | `{ id, kind: 'product_image'|'logo', target_id, blob, sha256, status, created_at? }` | Images waiting for upload; failed entries older than 30 days are trimmed |
| `print_jobs` | `{ id, sale_id?, refund_id?, kind, status: 'queued'|'printing'|'done'|'failed', error?, created_at }` | Print history and retry; `done` jobs older than 90 days are trimmed |
| `stock_levels` | `{ product_id, on_hand_milli }` | Cache = Σ `stock_movements.qty_delta_milli`; updated in the same transaction as each movement; rebuildable |
| `party_balances` | `{ party_type, party_id, balance, last_activity_at, oldest_unpaid_at }` | Cache = Σ `ledger_entries.amount`; rebuildable |

`CartLine = { key, product_id | null, name, sku, qty_milli, unit_price, discount_type?, discount_value, unit_cost, image_key? }`.

**Local retention (D-226).** A daily idle pass trims only local-only operational logs: completed `print_jobs` older than 90 days, failed `file_queue` uploads older than 30 days and `kv.pull_errors` older than 30 days. Business rows (sales, stock movements, ledger entries, refunds, day closes, audit) are never deleted on the till; the server backup and the shop export are the long-term record.

### 3.2 Rebuild

Settings → Sync → "Rebuild local data" (owner only; [screens/17](screens/17-settings.md#sync-everyone-sees-status-actions-need-owner)) pushes pending ops, then clears `stock_levels` and `party_balances` and recomputes them from movements and ledger entries. The app also runs a silent consistency check once a day at first unlock: recompute 20 random products and parties; if any differ, rebuild and log `cache_rebuilt` in `audit_log`.

**Cart/held-bill shape (local-only).** A bundle group lives in the existing `Cart.lines` JSON; there is no local `bundle_cart` table. Each component line carries `bundle_id`, `bundle_group`, `bundle_name`, `bundle_qty`, `bundle_price` and `bundle_component_qty_milli`; the group header is derived from those fields. A held bill stores the recipe/price snapshot taken when the bundle was added, so editing or deleting the bundle later does not change an open or held cart. The cart adds the group as one block; the 60-line limit counts the component lines.

## 4. Derived values

| Value | Formula | Where |
|---|---|---|
| Stock on hand | Σ `stock_movements.qty_delta_milli` for the product (and branch, v2) | `stock_levels` cache on till; computed on demand on server |
| Customer balance | Σ `ledger_entries.amount` where `party_type='customer'` | `party_balances`; > 0 means the customer owes the shop |
| Supplier balance | Σ `ledger_entries.amount` where `party_type='supplier'` | `party_balances`; > 0 means the shop owes the supplier |
| `sales.status` | `void` if a `sale_voids` row exists; else `refunded` if every line's refunded qty = sold qty; else `part_refunded` if any refund; else `paid` | Recomputed on the till and on the server whenever a refund or void for the sale is inserted. Not sent in ops. |
| Average cost | [07 §7](07-money-rules.md#7-cost-weighted-average) | Server recomputes and writes `products.avg_cost`; till computes provisionally |
| Bundle availability | `min(floor(on_hand_milli_i / qty_milli_i))` over active tracked components (untracked components ignored; all untracked → "made to order") | Read-only derivation on the till for the Sell tile, product detail and cart warning; no stored counter |
| Bundle sold count | count of distinct `bundle_group` in `sale_lines` for a `bundle_id` (minus fully refunded groups) | Bundle product detail and a later bundle report; never sum `sale_lines.qty_milli` or the component count |

## 5. Record recipes (which rows each action writes)

All rows of one action are written in **one Dexie transaction** together with their outbox ops.

| Action | Rows written |
|---|---|
| Bundle product create/edit | 1 `products` on create or when the bundle price/name changes (`kind='bundle'`, `track_stock=0`); 1..20 `bundle_items` upserts/soft deletes on a recipe edit; 1 `audit_log` `bundle_change` with the before/after recipe; a price edit also writes `price_change`. No stock movement |
| Sale | 1 `sales`; n `sale_lines` (with `warranty_until` when the product has `warranty_days > 0`); a bundle sale writes one line per component, never a line for the bundle product itself, with the seven `bundle_*` fields; `sales.line_count` and `sales.items_qty_milli` count those component lines/units, not bundles (a 4-component bundle × 2 is 4 lines and 8 units; the bundle header is a UI grouping only); 0..3 `payments` (direction in, purpose sale, one per method used); 1 `ledger_entries` (+udhaar) if udhaar part > 0; n `stock_movements` (reason `sale`, −qty) for lines with `track_stock = 1`; `audit_log` if any discount exceeded the cashier limit (manager override) |
| Backdated sale | Same rows as Sale, plus 1 `audit_log` `sale_backdated` (`after_json`: attributed staff, business date, reason, recorded_at). The sale is written on the owner's device with `business_date` = the chosen date and `created_at` = the entry time; the attributed `staff_id` is the cashier who made it ([D-173](decisions.md#decisions-log)) |
| Refund | 1 `refunds` (split into paid part and udhaar part, [07 §6.1](07-money-rules.md#61-refunds-on-udhaar-bills)); n `refund_lines`; a whole-bundle return writes one refund line per component and includes every component line of the touched `bundle_group` with the same `k` whole bundles; 1 `payments` (direction out, purpose refund, `method`, `amount`) if `amount > 0`; 1 `ledger_entries` (customer, −`udhaar_part`, source refund) if `udhaar_part > 0`; `stock_movements` (`refund_return`, +qty) for restocked lines; `audit_log` |
| Void | 1 `sale_voids`; reversing `payments` (direction out, purpose void) for each original payment; reversing `ledger_entries` (−udhaar); `stock_movements` (`void_return`, +qty); `audit_log` |
| Reissue | Void (above) + a new sale with `replaces_sale_id`, then `sale_voids.replacement_sale_id` is known up front because the new sale ID is generated before writing |
| Customer payment | 1 `payments` (in, customer_payment, party) + 1 `ledger_entries` (−amount, source payment) ; promise status → `kept` if the balance reaches ≤ promised remaining |
| Delivery (purchase) | 1 `purchases`; n `purchase_lines`; n `stock_movements` (`purchase`, +qty, `unit_cost` = `landed_unit_cost`); 1 `ledger_entries` (supplier, +total, source purchase); if paid_now > 0: 1 `payments` (out, purchase_paid_now) + 1 `ledger_entries` (supplier, −paid_now, source payment); product `last_cost` upsert per line |
| Pay supplier | 1 `payments` (out, supplier_payment) + 1 `ledger_entries` (supplier, −amount) |
| Return to supplier | 1 `supplier_returns`; n `supplier_return_lines`; n `stock_movements` (`supplier_return`, −qty, `ref_type` supplier_return, `unit_cost` NULL so avg cost is not recomputed) for lines with `track_stock = 1`; 1 `ledger_entries` (supplier, −total, source supplier_return); if `refund_received > 0`: 1 `payments` (direction in, purpose `supplier_refund`, `refund_method`, party supplier, `supplier_return_id`) + 1 `ledger_entries` (supplier, +refund_received, source payment); 1 `audit_log` `supplier_return` |
| Stock adjust | 1 `stock_movements` (reason code, signed qty, note); for `count`: qty = counted − on_hand **at the moment of saving** (not the frozen "expected" shown when the count started) |
| Bundle/component delete | Soft-delete the product (`deleted_at`, `rev + 1`) and write `product_delete`; a component used by an active bundle is blocked until the recipe is removed. Deleting a bundle leaves its `bundle_items`/saved sales untouched (history and reprints keep the snapshot) |
| Expense | 1 `expenses`; a reversal is 1 more `expenses` row with `reverses_id` |
| Pay-in / pay-out | 1 `cash_moves` |
| Day close | 1 `day_closes`; forces a sync |
| Opening balance for a customer/supplier | 1 `ledger_entries` (source opening) |
