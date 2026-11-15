-- D-228: covering index for the nightly change_log prune.
--
-- The prune takes `MAX(seq)` for one tenant and `at < cutoff`. A tenant-leading
-- covering index answers that from the index alone; the old `change_log_at` index
-- still had to look up each row's tenant and seq. Additive only; SCHEMA_VERSION is
-- unchanged.
CREATE INDEX change_log_prune ON change_log (tenant_id, at, seq);
