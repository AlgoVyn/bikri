-- Shops can hide the logo from printed receipts without removing the uploaded image
-- (screens/17). Default 1 keeps existing and new receipts unchanged.
ALTER TABLE shop ADD COLUMN show_logo_on_receipt INTEGER NOT NULL DEFAULT 1
  CHECK (show_logo_on_receipt IN (0,1));

-- New wire field: the till and Worker must agree on schema 8.
UPDATE meta SET value = '8' WHERE key = 'schema_version';
