import { describe, expect, it } from 'vitest';
import { parseOrigin, parsePeekTarget, peekValue } from './peek.ts';
import { recordBackForPath } from './recordBack.ts';

const A = '01JB0000000000000000000001';
const B = '01JB0000000000000000000002';

describe('reference peek targets', () => {
  it('accepts the four record kinds with a ULID', () => {
    expect(parsePeekTarget(`product:${A}`)).toEqual({
      kind: 'product',
      id: A,
    });
    expect(parsePeekTarget(`bill:${A}`)).toEqual({ kind: 'bill', id: A });
    expect(parsePeekTarget(`customer:${A}`)).toEqual({
      kind: 'customer',
      id: A,
    });
    expect(parsePeekTarget(`delivery:${A}`)).toEqual({
      kind: 'delivery',
      id: A,
    });
    expect(peekValue({ kind: 'bill', id: B })).toBe(`bill:${B}`);
  });

  it('rejects unknown kinds, malformed ids and extra segments', () => {
    expect(parsePeekTarget(`supplier:${A}`)).toBeNull();
    expect(parsePeekTarget(`bill:${A}:extra`)).toBeNull();
    expect(parsePeekTarget('bill:')).toBeNull();
    expect(parsePeekTarget(`bill:${A.toLowerCase()}`)).toBeNull();
    expect(parsePeekTarget(undefined)).toBeNull();
    expect(parsePeekTarget(42)).toBeNull();
  });
});

describe('peek origin state', () => {
  it('accepts route-relative and base-prefixed internal hrefs', () => {
    expect(
      parseOrigin({
        href: `/sales/${A}`,
        labelKey: 'peek.origin_bill',
        labelParams: { invoice: 'A-A-1' },
        mode: 'history',
      }),
    ).toEqual({
      href: `/sales/${A}`,
      labelKey: 'peek.origin_bill',
      labelParams: { invoice: 'A-A-1' },
      mode: 'history',
    });
    expect(
      parseOrigin({
        href: `/bikri/products/${A}`,
        labelKey: 'peek.origin_product',
        mode: 'replace',
      }),
    ).not.toBeNull();
  });

  it('drops external, malformed and unknown-label origins', () => {
    expect(
      parseOrigin({
        href: 'https://example.com/sales/1',
        labelKey: 'peek.origin_bill',
        mode: 'history',
      }),
    ).toBeNull();
    expect(
      parseOrigin({
        href: `//example.com/sales/${A}`,
        labelKey: 'peek.origin_bill',
        mode: 'history',
      }),
    ).toBeNull();
    expect(
      parseOrigin({
        href: `/sales/${A}`,
        labelKey: 'office.bill.back',
        mode: 'history',
      }),
    ).toBeNull();
    expect(
      parseOrigin({
        href: `/sales/${A}`,
        labelKey: 'peek.origin_bill',
        mode: 'pop',
      }),
    ).toBeNull();
  });
});

describe('record back fallback', () => {
  it('finds the canonical parent for record detail routes only', () => {
    expect(recordBackForPath(`/products/${A}`)).toEqual({
      to: '/products',
      shortLabelKey: 'nav.products',
    });
    expect(recordBackForPath(`/sales/${A}/`)).toEqual({
      to: '/sales',
      shortLabelKey: 'nav.sales',
    });
    expect(recordBackForPath(`/udhaar/${A}`)).toEqual({
      to: '/udhaar',
      shortLabelKey: 'peek.customers',
    });
    expect(recordBackForPath(`/suppliers/${A}`)).toEqual({
      to: '/suppliers',
      shortLabelKey: 'nav.suppliers',
    });
  });

  it('does not turn forms or child dialogs into record pages', () => {
    expect(recordBackForPath('/products/new')).toBeNull();
    expect(recordBackForPath(`/products/${A}/edit`)).toBeNull();
    expect(recordBackForPath(`/sales/${A}/refund`)).toBeNull();
    expect(recordBackForPath('/')).toBeNull();
  });
});
