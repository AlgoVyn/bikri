import { describe, expect, it } from 'vitest';
import type { HistoryRef } from '../data/catalog.ts';
import { type HistoryLinkAccess, historyLinkVisible } from './historyLink.ts';

const purchase: HistoryRef = {
  kind: 'purchase',
  purchaseId: 'pur-1',
  supplierId: 'sup-1',
  invoiceNo: 'SUP-1',
};
const sale: HistoryRef = {
  kind: 'sale',
  saleId: 'sale-1',
  invoiceNo: 'A-1',
  businessDate: '2026-11-23',
  branchId: 'br-1',
};

const cashier: HistoryLinkAccess = {
  role: 'cashier',
  support: false,
  canViewReports: false,
  canViewCost: false,
  canCreatePurchase: false,
  today: '2026-11-23',
  branchId: 'br-1',
};

describe('stock-history links (screens/13, UI-H1)', () => {
  it('hides delivery links without purchase.create or cost.view', () => {
    expect(historyLinkVisible(purchase, cashier)).toBe(false);
    expect(
      historyLinkVisible(purchase, { ...cashier, canViewCost: true }),
    ).toBe(true);
    expect(
      historyLinkVisible(purchase, { ...cashier, canCreatePurchase: true }),
    ).toBe(true);
  });

  it('links a bill only when BillDetail would open it (today, same branch or report.view)', () => {
    expect(historyLinkVisible(sale, cashier)).toBe(true);
    expect(historyLinkVisible(sale, { ...cashier, today: '2026-11-24' })).toBe(
      false,
    );
    expect(historyLinkVisible(sale, { ...cashier, branchId: 'br-2' })).toBe(
      false,
    );
    // No device branch is not a branch restriction.
    expect(historyLinkVisible(sale, { ...cashier, branchId: null })).toBe(true);
    // report.view on an owner profile sees every date.
    expect(
      historyLinkVisible(sale, {
        ...cashier,
        role: 'owner',
        today: '2026-11-24',
        branchId: 'br-2',
        canViewReports: true,
      }),
    ).toBe(true);
    expect(
      historyLinkVisible(sale, {
        ...cashier,
        today: '2026-11-24',
        branchId: 'br-2',
        support: true,
        canViewReports: true,
      }),
    ).toBe(true);
  });
});
