/** Platform tables that must be present in a complete dump (no per-tenant counts). */
export const PLATFORM_TABLES = [
  'shop_requests',
  'operator_audit',
  'expense_category_templates',
];

/**
 * Tenant tables included in the nightly backup manifest. Keep in sync with
 * `packages/db/src/tables.ts` (the backup test compares both lists).
 */
export const BACKUP_TABLES = [
  'tenant_usage',
  'change_log',
  'applied_ops',
  'sync_conflicts',
  'devices',
  'enrolment_codes',
  'owner_email_codes',
  'shop',
  'branches',
  'staff',
  'categories',
  'products',
  'product_barcodes',
  'customers',
  'suppliers',
  'expense_categories',
  'promises',
  'sales',
  'sale_lines',
  'payments',
  'refunds',
  'refund_lines',
  'sale_voids',
  'ledger_entries',
  'stock_movements',
  'purchases',
  'purchase_lines',
  'supplier_returns',
  'supplier_return_lines',
  'expenses',
  'cash_moves',
  'day_closes',
  'audit_log',
];

/**
 * Tables in a per-tenant `bikri-export` zip (snapshot tables without operational rows), in
 * dependency order so restore never writes a payment before its refund/purchase/return.
 */
export const EXPORT_TABLES = [
  'shop',
  'branches',
  'devices',
  'staff',
  'categories',
  'products',
  'product_barcodes',
  'customers',
  'suppliers',
  'expense_categories',
  'promises',
  'sales',
  'sale_lines',
  'refunds',
  'refund_lines',
  'sale_voids',
  'purchases',
  'purchase_lines',
  'supplier_returns',
  'supplier_return_lines',
  'payments',
  'ledger_entries',
  'stock_movements',
  'expenses',
  'cash_moves',
  'day_closes',
  'audit_log',
  'sync_conflicts',
];
