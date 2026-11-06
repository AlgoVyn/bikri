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
