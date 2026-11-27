-- 0039_perf_review_remediation.sql
--
-- 2026-11-27 whole-app performance review: the remaining D1/API batch (H8, M14, M15,
-- M16, L2, L13). Index/trigger-only: `SCHEMA_VERSION` and `CLIENT_SCHEMA_VERSION`
-- stay at 10 and Dexie is unchanged.

-- M15: the nightly prune filters these tables by time alone (no tenant predicate),
-- so the existing tenant-leading indexes cannot serve it.
CREATE INDEX enrolment_codes_expiry ON enrolment_codes (expires_at);
CREATE INDEX owner_email_codes_expiry ON owner_email_codes (expires_at);
CREATE INDEX change_log_watermarks_day ON change_log_watermarks (day);

-- L2: operator_audit is only read by primary key; these two indexes have no reader.
DROP INDEX IF EXISTS operator_audit_request;
DROP INDEX IF EXISTS operator_audit_time;

-- M16: a simple product whose UPDATE happens to list `kind` must not run a second
-- self-UPDATE just to clear a `bundle_since` it never had.
DROP TRIGGER products_bundle_since_clear;
CREATE TRIGGER products_bundle_since_clear
AFTER UPDATE OF kind ON products
WHEN NEW.kind <> 'bundle'
  AND (OLD.kind = 'bundle' OR OLD.bundle_since IS NOT NULL)
BEGIN
  UPDATE products
  SET bundle_since = NULL
  WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
END;

-- L13: a line with no product (a free-text line, or a deleted product reference) must
-- not run the bundle-product EXISTS probe at all.
DROP TRIGGER sale_lines_no_bundle_product;
CREATE TRIGGER sale_lines_no_bundle_product
BEFORE INSERT ON sale_lines
WHEN NEW.product_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM products p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.id = NEW.product_id
      AND p.kind = 'bundle'
      AND COALESCE(p.bundle_since, p.updated_at) <= NEW.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot be a sale line');
END;

DROP TRIGGER quotation_lines_no_bundle_product_insert;
CREATE TRIGGER quotation_lines_no_bundle_product_insert
BEFORE INSERT ON quotation_lines
WHEN NEW.product_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM products p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.id = NEW.product_id
      AND p.kind = 'bundle'
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot be a quotation line');
END;

DROP TRIGGER quotation_lines_no_bundle_product_update;
CREATE TRIGGER quotation_lines_no_bundle_product_update
BEFORE UPDATE OF product_id ON quotation_lines
WHEN NEW.product_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM products p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.id = NEW.product_id
      AND p.kind = 'bundle'
  )
BEGIN
  SELECT RAISE(ABORT, 'a bundle cannot be a quotation line');
END;
