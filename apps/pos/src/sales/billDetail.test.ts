import { describe, expect, it } from 'vitest';
import { billActions } from './BillDetail.tsx';

describe('bill more-actions (UI-L5)', () => {
  it('offers Void & reissue only with sale.create', () => {
    expect(
      billActions({ canRefund: false, canVoid: true, canCreate: true }).map(
        (action) => action.kind,
      ),
    ).toEqual(['void', 'reissue']);
    expect(
      billActions({ canRefund: true, canVoid: true, canCreate: false }).map(
        (action) => action.kind,
      ),
    ).toEqual(['refund', 'void']);
  });

  it('keeps the refund action independent of the void rules', () => {
    expect(
      billActions({ canRefund: true, canVoid: false, canCreate: true }).map(
        (action) => action.kind,
      ),
    ).toEqual(['refund']);
  });
});
