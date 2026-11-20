/** Permission keys and role defaults (05 §6). Per-person overrides live in staff.permissions_json. */
export const PERMISSIONS = [
  'sale.create',
  'sale.discount',
  'sale.udhaar',
  'sale.below_cost',
  'sale.void',
  'sale.backdate',
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
  // Recording a sale on a past business date is owner-only by default (D-173).
  'sale.backdate',
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
  if (role === 'cashier') return CASHIER_ALLOWED.has(permission);
  // A corrupt or future role string must not inherit cashier permissions.
  return false;
}

/** Role default, overridden by `{"refund.create": true}`-style entries in permissions_json. */
export function can(
  role: Role,
  permissionsJson: string,
  permission: Permission,
): boolean {
  // The owner stays in control even if a hand-edited restore or an old bug wrote a
  // deny override into permissions_json (05 §6).
  if (role === 'owner') return true;
  try {
    const parsed: unknown = JSON.parse(permissionsJson || '{}');
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      if (Object.hasOwn(parsed, permission)) {
        const value = (parsed as Record<string, unknown>)[permission];
        if (typeof value === 'boolean') return value;
      }
    }
  } catch {
    // Bad JSON falls back to the role default.
  }
  return roleAllows(role, permission);
}
