import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../i18n/i18n.ts';
import { PinBoxes } from './PinBoxes.tsx';

let last = '';
function Harness() {
  const [pin, setPin] = useState('');
  last = pin;
  return <PinBoxes idPrefix="p" label="PIN" value={pin} onChange={setPin} />;
}

beforeAll(async () => {
  await initI18n('en');
});

describe('PinBoxes', () => {
  it('types across boxes, clears without shifting, and overwrites', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByLabelText('PIN digit 1'));
    await user.keyboard('1234');
    expect(last).toBe('1234');
    for (let i = 1; i <= 4; i += 1)
      fireEvent.change(screen.getByLabelText(`PIN digit ${i}`), {
        target: { value: '' },
      });
    expect(last).toBe('');
    fireEvent.change(screen.getByLabelText('PIN digit 3'), {
      target: { value: '7' },
    });
    expect(last).toBe('  7');
    await user.click(screen.getByLabelText('PIN digit 1'));
    await user.keyboard('4826');
    expect(last).toBe('4826');
    await user.click(screen.getByLabelText('PIN digit 2'));
    await user.keyboard('9');
    expect(last).toBe('4926');
  });
});
