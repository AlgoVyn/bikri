-- Some shops put the shop name inside their logo. Allow the receipt header to omit
-- the separate name line while keeping the logo (screens/17, D-232).
ALTER TABLE shop ADD COLUMN show_shop_name_on_receipt INTEGER NOT NULL DEFAULT 1
  CHECK (show_shop_name_on_receipt IN (0,1));
