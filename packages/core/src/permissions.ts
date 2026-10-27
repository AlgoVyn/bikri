/** Permission keys and role defaults (05 §6). Per-person overrides live in staff.permissions_json. */
export const PERMISSIONS = [
  'sale.create',
  'sale.discount',
  'sale.udhaar',
  'sale.below_cost',
  'sale.void',
  'refund.create',
  'drawer.open',
  'cash.move',
  'dayclose.create',
  'dayclose.view_expected',
  'payment.receive',
  'party.edit',
  'party.delete',
  'catalog.edit',
  'catalog.delete',
  'cost.view',
  'stock.adjust',
  'purchase.create',
  'expense.create',
  'report.view',
  'export.data',
  'settings.shop',
  'settings.staff',
  'devices.manage',
  'settings.device',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = 'owner' | 'manager' | 'cashier';

const MANAGER_DENIED: ReadonlySet<Permission> = new Set([
  'party.delete',
  'catalog.delete',
  'settings.shop',
  'settings.staff',
  'devices.manage',
]);

/**
 * Cashier defaults. `party.edit` (create only), `expense.create` (cash ≤ Rs 2,000),
 * `report.view` (today only) and `settings.device` (display/language) are granted with limits
 * that the screens enforce.
 */
const CASHIER_ALLOWED: ReadonlySet<Permission> = new Set([
  'sale.create',
  'sale.discount',
  'sale.udhaar',
  'dayclose.create',
  'payment.receive',
  'party.edit',
  'expense.create',
  'report.view',
  'settings.device',
]);

export function roleAllows(role: Role, permission: Permission): boolean {
  if (role === 'owner') return true;
  if (role === 'manager') return !MANAGER_DENIED.has(permission);
  return CASHIER_ALLOWED.has(permission);
}

/** Role default, overridden by `{"refund.create": true}`-style entries in permissions_json. */
export function can(
  role: Role,
  permissionsJson: string,
  permission: Permission,
): boolean {
  try {
    const overrides = JSON.parse(permissionsJson || '{}') as Record<
      string,
      unknown
    >;
    const value = overrides[permission];
    if (typeof value === 'boolean') return value;
  } catch {
    // Bad JSON falls back to the role default.
  }
  return roleAllows(role, permission);
}
