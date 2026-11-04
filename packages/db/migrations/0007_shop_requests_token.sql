-- The public request-status lookup is by random token; without this index every poll
-- scans the platform table.
CREATE INDEX shop_requests_token ON shop_requests (status_token_hash);
