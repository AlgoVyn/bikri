import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '../i18n/i18n.ts';
import { UiKitPage } from './UiKitPage.tsx';

beforeEach(async () => {
  await initI18n('en');
});

async function seriousViolations(): Promise<axe.Result[]> {
  const results = await axe.run(document.body, { resultTypes: ['violations'] });
  return results.violations.filter(
    (violation) =>
      violation.impact === 'serious' || violation.impact === 'critical',
  );
}

describe('UI kit accessibility', () => {
  it('has no serious or critical axe violations, including open dialogs', async () => {
    const user = userEvent.setup();
    render(<UiKitPage />);
    expect(screen.getByRole('heading', { name: 'UI kit' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Urdu' })).toBeTruthy();
    let violations = await seriousViolations();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    const confirms = screen.getAllByRole('button', { name: 'Open confirm' });
    const overrides = screen.getAllByRole('button', { name: 'Open override' });
    const confirm = confirms[0];
    const override = overrides[0];
    if (confirm === undefined || override === undefined) {
      throw new Error('kit actions missing');
    }
    await user.click(confirm);
    violations = await seriousViolations();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    await user.keyboard('{Escape}');
    await user.click(override);
    violations = await seriousViolations();
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
