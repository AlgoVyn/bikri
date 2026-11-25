/**
 * Shared column classification for the tenant JSON/CSV exports (`bikri-export` v2).
 *
 * The till's full export (`apps/pos/src/data/shopExport.ts`) and the nightly
 * tenant extract (`tools/backup/tenant-extract.mjs`) must show the same units:
 * money as rupees, event times as ISO strings in the shop's time zone, and no
 * server-only columns. Keeping one list here prevents the two tools drifting.
 */

/** Integer paisa columns (02 §1). CSV exports divide these by 100. */
export const MONEY_FIELDS: ReadonlySet<string> = new Set([
  'amount',
  'avg_cost',
  'bank_total',
  'bill_discount',
  'bill_discount_alloc',
  'bill_discount_value',
  'bundle_discount',
  'bundle_discount_total',
  'bundle_price',
  'card_total',
  'cash_expenses',
  'cash_refunds',
  'cash_sales',
  'cash_tendered',
  'change_given',
  'charges_alloc',
  'cost_snapshot',
  'counted_cash',
  'credit_limit',
  'default_credit_limit',
  'difference',
  'discount',
  'discount_value',
  'exact_amount',
  'expected_cash',
  'gross',
  'gross_total',
  'item_discount_total',
  'landed_unit_cost',
  'last_cost',
  'line_total',
  'net',
  'opening_cash',
  'other_charges',
  'paid_now',
  'paid_total',
  'pay_ins',
  'pay_outs',
  'price',
  'refund_received',
  'round_total_to',
  'rounding',
  'rounding_alloc',
  'subtotal',
  'supplier_cash_in',
  'supplier_cash_out',
  'tax',
  'tax_alloc',
  'total',
  'udhaar_amount',
  'udhaar_cash_in',
  'udhaar_given',
  'udhaar_part',
  'unit_cost',
  'unit_cost_snapshot',
  'unit_credit',
  'unit_price',
]);

/** Epoch-millisecond columns. CSV exports render these as shop-local ISO strings. */
export const TIME_FIELDS: ReadonlySet<string> = new Set([
  'applied_at',
  'at',
  'cost_changed_at',
  'created_at',
  'deleted_at',
  'email_checked_at',
  'email_verification_sent_at',
  'email_verified_at',
  'enrolled_at',
  'expires_at',
  'last_owner_export_at',
  'last_report_at',
  'last_seen_at',
  'oldest_pending_at',
  'period_end',
  'period_start',
  'read_only_seen_at',
  'restore_point_at',
  'reviewed_at',
  'revoked_at',
  'setup_completed_at',
  'status_changed_at',
  'updated_at',
  'used_at',
]);

/** Server-only columns that must not appear in a tenant export. */
export const EXPORT_HIDDEN_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  devices: ['token_hash', 'enrolled_by', 'last_report_at'],
  products: ['on_hand_milli', 'cost_changed_at', 'bundle_since'],
};
