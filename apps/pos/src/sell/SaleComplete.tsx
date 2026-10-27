import { formatMoney } from '@bikri/core';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary } from '../components/classes.ts';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import type { Done } from './PayDialog.tsx';

/** Step 2 of the pay modal (screens/07). */
export function SaleComplete({
  done,
  onNewSale,
}: {
  done: Done;
  onNewSale: () => void;
}) {
  const { t } = useTranslation();
  const { sale } = done;
  const newSale = useRef<HTMLButtonElement>(null);
  useEffect(() => newSale.current?.focus(), []);
  useHotkey(plainKey('n'), onNewSale);
  const change = Number(sale.change_given ?? 0);
  const udhaar = Number(sale.udhaar_amount ?? 0);
  return (
    <div
      className="flex flex-col items-center gap-3 py-4 text-center"
      data-testid="sale-complete"
    >
      <span
        aria-hidden="true"
        className="flex size-16 items-center justify-center rounded-full bg-success-subtle text-figure text-success-subtle-ink"
      >
        ✓
      </span>
      <p className="text-title" data-testid="sale-saved">
        {t('pay.saved', { invoice: String(sale.invoice_no) })}
      </p>
      {change > 0 ? (
        <p className="text-figure font-semibold" data-testid="done-change">
          {t('pay.change', { amount: formatMoney(change) })}
        </p>
      ) : null}
      {udhaar > 0 ? (
        <p data-testid="done-udhaar">
          {t('pay.udhaar_written', {
            amount: formatMoney(udhaar),
            name: done.customerName,
            balance: formatMoney(done.balance),
          })}
        </p>
      ) : null}
      <button
        ref={newSale}
        type="button"
        className={`${buttonPrimary} min-h-14 w-full text-title`}
        onClick={onNewSale}
      >
        {t('pay.new_sale')} <KeyBadge keys="Enter" />
      </button>
    </div>
  );
}
