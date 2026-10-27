import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../i18n/i18n.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { EmptyState } from './EmptyState.tsx';
import { ExportMenu } from './ExportMenu.tsx';
import { KeyBadge } from './KeyBadge.tsx';
import { filterMoneyDraft, MoneyInput } from './MoneyInput.tsx';
import { MoneyText } from './MoneyText.tsx';
import { OverrideDialog } from './OverrideDialog.tsx';
import { PhoneInput } from './PhoneInput.tsx';
import { QtyInput } from './QtyInput.tsx';
import { isRapidBarcode, SearchBox } from './SearchBox.tsx';
import { ToastProvider, useToast } from './Toast.tsx';

function QtyHarness() {
  const [value, setValue] = useState<number | null>(0);
  return (
    <QtyInput label="Quantity" unit="pc" value={value} onChange={setValue} />
  );
}

function PhoneHarness() {
  const [value, setValue] = useState('');
  return (
    <PhoneInput
      label="Phone"
      value={value}
      onChange={(next) => {
        setValue(next ?? '');
      }}
    />
  );
}

function ToastHarness() {
  const { push } = useToast();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          push('Saved.');
        }}
      >
        info
      </button>
      <button
        type="button"
        onClick={() => {
          push('Broken.', 'error');
        }}
      >
        error
      </button>
      <button
        type="button"
        onClick={() => {
          push('One');
        }}
      >
        one
      </button>
      <button
        type="button"
        onClick={() => {
          push('Two');
        }}
      >
        two
      </button>
      <button
        type="button"
        onClick={() => {
          push('Three');
        }}
      >
        three
      </button>
      <button
        type="button"
        onClick={() => {
          push('Four');
        }}
      >
        four
      </button>
    </div>
  );
}

beforeEach(async () => {
  await initI18n('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('money and quantity fields', () => {
  it('normalises digits and keeps at most 2 decimals', () => {
    expect(filterMoneyDraft('۴۳٫۵', false)).toBe('43.5');
    expect(filterMoneyDraft('1,234.567', false)).toBe('1234.56');
    expect(filterMoneyDraft('\u2212500', true)).toBe('-500');
  });

  it('stores paisa from the money field', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MoneyInput label="Amount" value={null} onChange={onChange} />);
    await user.type(screen.getByLabelText('Amount'), '43.5');
    expect(onChange).toHaveBeenLastCalledWith(4350);
  });

  it('steps quantity in whole units', async () => {
    const user = userEvent.setup();
    render(<QtyHarness />);
    await user.click(screen.getByRole('button', { name: 'Increase quantity' }));
    expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe(
      '1',
    );
    await user.click(screen.getByRole('button', { name: 'Decrease quantity' }));
    expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe(
      '0',
    );
  });

  it('keeps money LTR inside bdi', () => {
    render(<MoneyText paisa={-50000} />);
    const node = screen.getByText('−Rs 500');
    expect(node.tagName).toBe('BDI');
    expect(node.getAttribute('dir')).toBe('ltr');
  });
});

describe('phone and search', () => {
  it('formats a mobile number and offers WhatsApp', async () => {
    const user = userEvent.setup();
    render(<PhoneHarness />);
    const field = screen.getByLabelText('Phone');
    await user.type(field, '03001234567');
    fireEvent.blur(field);
    expect((field as HTMLInputElement).value).toBe('0300 1234567');
    expect(
      screen.getByRole('link', { name: 'WhatsApp' }).getAttribute('href'),
    ).toBe('https://wa.me/923001234567');
  });

  it('shows the phone error for junk', async () => {
    const user = userEvent.setup();
    render(<PhoneInput label="Phone" value="" onChange={() => {}} />);
    const field = screen.getByLabelText('Phone');
    await user.type(field, '12');
    fireEvent.blur(field);
    expect(
      screen.getByText('Enter a valid Pakistan phone number.'),
    ).toBeTruthy();
  });

  it('treats a fast Enter as a barcode and a slow Enter as search', () => {
    expect(isRapidBarcode([0, 10, 20, 29], 39, '12345')).toBe(true);
    expect(isRapidBarcode([0, 40], 80, '12345')).toBe(false);
    const onSearch = vi.fn();
    const onBarcode = vi.fn();
    let now = 0;
    render(
      <SearchBox
        label="Search"
        value="12345"
        clock={() => now}
        onChange={() => {}}
        onSearch={onSearch}
        onBarcode={onBarcode}
      />,
    );
    const field = screen.getByRole('searchbox');
    for (const key of ['1', '2', '3', '4', '5']) {
      now += 10;
      fireEvent.keyDown(field, { key });
    }
    now += 10;
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onBarcode).toHaveBeenCalledWith('12345');
    expect(onSearch).not.toHaveBeenCalled();
  });
});

describe('dialogs, export, toast, and key hints', () => {
  it('confirms only when Enter is pressed on the danger button', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} />,
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    await user.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    screen.getByRole('button', { name: 'Delete' }).focus();
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('cancels a confirm dialog with Escape', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} onConfirm={() => {}} />,
    );
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('asks for a PIN and only closes when verify accepts it', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const verify = vi.fn<(pin: string) => Promise<boolean>>();
    verify.mockResolvedValueOnce(false);
    verify.mockResolvedValueOnce(true);
    render(<OverrideDialog open onOpenChange={onOpenChange} verify={verify} />);
    const pin = screen.getByLabelText('Manager PIN');
    await user.type(pin, '12');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByText('Enter the PIN.')).toBeTruthy();
    await user.clear(pin);
    await user.type(pin, '1234');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(verify).toHaveBeenCalledWith('1234', expect.any(String));
    expect(await screen.findByText('PIN not accepted.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('runs export actions', async () => {
    const user = userEvent.setup();
    const onCsv = vi.fn();
    const onPdf = vi.fn();
    const onShare = vi.fn();
    render(<ExportMenu onCsv={onCsv} onPdf={onPdf} onShare={onShare} />);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getByRole('menuitem', { name: 'CSV' }));
    expect(onCsv).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getByRole('menuitem', { name: 'PDF' }));
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getByRole('menuitem', { name: 'Share' }));
    expect(onPdf).toHaveBeenCalledOnce();
    expect(onShare).toHaveBeenCalledOnce();
  });

  it('dismisses info toasts after 4 seconds and keeps errors', async () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'info' }));
    expect(screen.getByRole('status').textContent).toContain('Saved.');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'error' }));
    await vi.advanceTimersByTimeAsync(8000);
    expect(screen.getByRole('alert').textContent).toContain('Broken.');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    for (const name of ['one', 'two', 'three', 'four']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(3);
    expect(screen.queryByText('One')).toBeNull();
    expect(screen.getByText('Four')).toBeTruthy();
  });

  it('hides key hints on a coarse pointer until a keyboard is used', () => {
    const query = {
      matches: true,
      media: '(pointer: coarse)',
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
    };
    vi.stubGlobal('matchMedia', () => query);
    const { rerender } = render(<KeyBadge keys="Alt+1" />);
    expect(screen.queryByText('Alt+1')).toBeNull();
    fireEvent.keyDown(window, { key: 'a' });
    rerender(<KeyBadge keys="Alt+1" />);
    expect(screen.getByText('Alt+1')).toBeTruthy();
  });

  it('renders an empty state action', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <EmptyState
        message="Nothing here yet."
        actionLabel="Add"
        onAction={onAction}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
