-- R2 usage accounting per shop (D-226). Additive only.
--
-- Every upload used to list the whole `t/<tenant>/` prefix to sum object sizes before
-- checking the 1 GB cap. That cost one R2 Class A list per upload and got slower as the
-- shop's photo library grew. `file_bytes` is now reserved atomically with a conditional
-- UPDATE; `files_initialized` makes the one-time backfill run only once per shop.
ALTER TABLE tenants ADD COLUMN file_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN files_initialized INTEGER NOT NULL DEFAULT 0;
