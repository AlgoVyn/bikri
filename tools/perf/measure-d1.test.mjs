import { describe, expect, it } from 'vitest';
import { largeFixture } from '../seed/large.ts';
import { measure, saleRows } from './measure-d1.mjs';

describe('T-062 D1 size measurement', () => {
  it('builds a scratch DB from the real migrations and reports growth', () => {
    const result = measure({ bills: 20, days: 5 });
    expect(result.tenants).toBe(2);
    expect(result.billsPerShop).toBe(20);
    expect(result.bytesPerBill).toBeGreaterThan(0);
    expect(result.bytesPerShopYear).toBeGreaterThan(result.bytesPerBill);
    expect(result.logicalRowsPerBill).toBe(27);
    expect(result.billsPerDay).toBeCloseTo(4);
  }, 30_000);

  it('generates the documented large fixture shape without the file', () => {
    const fixture = largeFixture({
      products: 3,
      customers: 2,
      bills: 4,
      days: 2,
    });
    expect(fixture.meta).toMatchObject({
      products: 3,
      customers: 2,
      bills: 4,
      days: 2,
    });
    expect(fixture.products).toHaveLength(3);
    expect(fixture.customers).toHaveLength(2);
    expect(fixture.bills).toHaveLength(4);
    expect(fixture.bills[0]?.sale.paid_total).toBeGreaterThan(0);
  });

  it('keeps the sale payment + udhaar split valid', () => {
    const { sale, payment, ledger } = saleRows(
      't',
      1,
      ['p-t-0'],
      'c-t-0',
      Date.UTC(2026, 9, 28),
    );
    expect(sale.paid_total + sale.udhaar_amount).toBe(sale.total);
    expect(payment.amount).toBe(sale.paid_total);
    expect(ledger.amount).toBe(sale.udhaar_amount);
  });
});
