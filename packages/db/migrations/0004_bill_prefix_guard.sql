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
