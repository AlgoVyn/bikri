import { describe, expect, it } from 'vitest';
import { saleLineFinal } from './refunds.ts';

describe('saleLineFinal (07 §3)', () => {
  it('exclusive: net − bill share + tax share + rounding share', () => {
    expect(
      saleLineFinal(
        {
          net: 350000,
          bill_discount_alloc: 4023,
          tax_alloc: 0,
          rounding_alloc: 0,
        },
        false,
      ),
    ).toBe(345977);
  });

  it('inclusive: tax is already inside the net, so it is not added again', () => {
    expect(
      saleLineFinal(
        {
          net: 100000,
          bill_discount_alloc: 0,
          tax_alloc: 17000,
          rounding_alloc: 0,
        },
        true,
      ),
    ).toBe(100000);
  });

  it('rejects non-integer amounts', () => {
    expect(() =>
      saleLineFinal(
        {
          net: 10.5,
          bill_discount_alloc: 0,
          tax_alloc: 0,
          rounding_alloc: 0,
        },
        false,
      ),
    ).toThrow(RangeError);
  });
});
