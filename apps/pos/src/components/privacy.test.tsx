import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '../i18n/i18n.ts';
import { maskMoney } from '../lib/money.ts';
import { MoneyText, useDisplayMoney } from './MoneyText.tsx';
import { PrivacyProvider, PrivacyValue } from './privacy.tsx';

function DisplayHarness() {
  const money = useDisplayMoney();
  return <span>{money(123_400)}</span>;
}

beforeEach(async () => {
  await initI18n('en');
});

afterEach(cleanup);

describe('privacy mode', () => {
  it('renders a fixed-width mask and no real amount while active', () => {
    render(
      <PrivacyProvider active>
        <MoneyText paisa={123_400} />
      </PrivacyProvider>,
    );
    expect(screen.getByText('Rs ••••')).toBeTruthy();
    expect(screen.getByText('Amount hidden')).toBeTruthy();
    expect(screen.queryByText(/1,234/u)).toBeNull();
  });

  it('keeps the real amount visible outside privacy mode', () => {
    render(
      <PrivacyProvider active={false}>
        <MoneyText paisa={123_400} />
      </PrivacyProvider>,
    );
    expect(screen.queryByText(/1,234/u)).toBeTruthy();
    expect(screen.queryByText('Rs ••••')).toBeNull();
  });

  it('masks interpolated display money and percentages without DOM values', () => {
    render(
      <PrivacyProvider active>
        <DisplayHarness />
        <PrivacyValue mask="••%">{'23.5%'}</PrivacyValue>
      </PrivacyProvider>,
    );
    expect(screen.getByText('Rs ••••')).toBeTruthy();
    expect(screen.getByText('••%')).toBeTruthy();
    expect(screen.queryByText(/1,234/u)).toBeNull();
    expect(screen.queryByText('23.5%')).toBeNull();
  });

  it("does not leak the amount's magnitude through the mask length", () => {
    expect(maskMoney(1)).toBe('Rs ••••');
    expect(maskMoney(99_999_900)).toBe('Rs ••••');
    expect(maskMoney(-50_000)).toBe('−Rs ••••');
  });
});
