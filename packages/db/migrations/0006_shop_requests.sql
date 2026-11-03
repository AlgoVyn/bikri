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
