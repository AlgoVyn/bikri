import { describe, expect, it } from 'vitest';
import { can, PERMISSIONS, roleAllows } from './permissions.ts';

describe('permission matrix (05 §6)', () => {
  it('owner has everything', () => {
    for (const p of PERMISSIONS) expect(roleAllows('owner', p)).toBe(true);
  });
  it('manager lacks deletes, shop/staff settings and devices', () => {
    expect(roleAllows('manager', 'refund.create')).toBe(true);
    expect(roleAllows('manager', 'cost.view')).toBe(true);
    for (const p of [
      'party.delete',
      'catalog.delete',
      'settings.shop',
      'settings.staff',
      'devices.manage',
    ] as const) {
      expect(roleAllows('manager', p)).toBe(false);
    }
  });
  it('cashier has the selling basics only', () => {
    expect(roleAllows('cashier', 'sale.create')).toBe(true);
    expect(roleAllows('cashier', 'report.view')).toBe(true);
    for (const p of [
      'refund.create',
      'cost.view',
      'catalog.edit',
      'purchase.create',
      'stock.adjust',
      'export.data',
    ] as const) {
      expect(roleAllows('cashier', p)).toBe(false);
    }
  });
  it('per-person overrides win, bad JSON falls back', () => {
    expect(can('cashier', '{"refund.create": true}', 'refund.create')).toBe(
      true,
    );
    expect(can('manager', '{"cost.view": false}', 'cost.view')).toBe(false);
    expect(can('cashier', 'not json', 'sale.create')).toBe(true);
    expect(can('cashier', '', 'cost.view')).toBe(false);
  });
});
