-- D-269 / fifth performance review P1: stop allocating device codes by fetching
-- every invoice number in the branch. The registry is server-only (never pulled by
-- tills) and is backfilled once from current devices, their code history and the
-- bills that already carry a code. Additive table + indexes; SCHEMA_VERSION stays 8.
CREATE TABLE branch_device_codes (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  branch_id   TEXT NOT NULL,
  device_code TEXT NOT NULL,
  PRIMARY KEY (tenant_id, branch_id, device_code),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
) STRICT;

-- Current devices.
INSERT OR IGNORE INTO branch_device_codes (tenant_id, branch_id, device_code)
SELECT tenant_id, branch_id, device_code FROM devices;

-- Codes a device kept after a branch move (comma-separated history).
WITH RECURSIVE split(tenant_id, branch_id, code, rest) AS (
  SELECT tenant_id, branch_id, '', device_code_history || ','
  FROM devices
  WHERE device_code_history <> ''
  UNION ALL
  SELECT tenant_id, branch_id,
    substr(rest, 1, instr(rest, ',') - 1),
    substr(rest, instr(rest, ',') + 1)
  FROM split
  WHERE rest <> ''
)
INSERT OR IGNORE INTO branch_device_codes (tenant_id, branch_id, device_code)
SELECT tenant_id, branch_id, code
FROM split
WHERE code <> '' AND length(code) BETWEEN 1 AND 3
  AND code NOT GLOB '*[^A-Z]*';

-- Codes only visible in existing invoice numbers (a device moved away and its
-- history predates 0005). Parse '<prefix>-<code>-<seq>'.
WITH parsed AS (
  SELECT tenant_id, branch_id, invoice_no, instr(invoice_no, '-') AS h1
  FROM sales
  WHERE instr(invoice_no, '-') > 1
),
split AS (
  SELECT tenant_id, branch_id, invoice_no, h1,
    substr(invoice_no, h1 + 1) AS rest,
    instr(substr(invoice_no, h1 + 1), '-') AS h2
  FROM parsed
  WHERE h1 > 1
)
INSERT OR IGNORE INTO branch_device_codes (tenant_id, branch_id, device_code)
SELECT tenant_id, branch_id, substr(rest, 1, h2 - 1)
FROM split
WHERE h2 > 1
  AND length(substr(invoice_no, 1, h1 - 1)) BETWEEN 1 AND 6
  AND substr(invoice_no, 1, h1 - 1) NOT GLOB '*[^A-Z0-9]*'
  AND length(substr(rest, 1, h2 - 1)) BETWEEN 1 AND 3
  AND substr(rest, 1, h2 - 1) NOT GLOB '*[^A-Z]*'
  AND substr(rest, h2 + 1) <> ''
  AND substr(rest, h2 + 1) NOT GLOB '*[^0-9]*';

-- The registry replaces the branch-invoice lookup used by device enrolment.
DROP INDEX sales_branch_invoice;

-- The nightly prune sums today's writes across shops before it budgets its deletes.
CREATE INDEX tenant_usage_day ON tenant_usage (day);
