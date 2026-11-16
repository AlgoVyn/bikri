-- 0022 added a shop column after the 1.1.0 schema bump. Set the database marker to the
-- Worker's SCHEMA_VERSION 7; a fresh database runs this right after 0022 (review L9).
UPDATE meta SET value = '7' WHERE key = 'schema_version';
