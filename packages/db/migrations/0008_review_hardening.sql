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
