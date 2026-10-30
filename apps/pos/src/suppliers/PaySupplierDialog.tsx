import { newId } from '@bikri/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { paySupplier, SupplierPaymentError } from '../data/purchases.ts';
import { formatShopMoney } from '../lib/money';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

type Method = 'cash' | 'card' | 'bank_wallet';
const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

/** Pay supplier (screens/13). */
export function PaySupplierDialog({
  open,
  onOpenChange,
  supplierId,
  supplierName,
  balance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: string;
  supplierName: string;
  balance: number;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<Method>('cash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [paymentId, setPaymentId] = useState(() => newId());
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount(Math.max(0, balance));
    setMethod('cash');
    setReference('');
    setNote('');
    setPaymentId(newId());
    setPending(false);
  }, [open, balance]);

  const save = async () => {
    if (!amount || amount <= 0 || pending) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      await paySupplier(
        db,
        { paymentId, supplierId, amount, method, reference, note },
        ctx,
      );
      toast.push(
        t('office.suppliers.payment_saved', {
          amount: formatShopMoney(amount),
        }),
      );
      onOpenChange(false);
    } catch (err) {
      if (err instanceof SupplierPaymentError)
        toast.push(t(`office.suppliers.payment_error_${err.code}`), 'error');
      else toast.push(t('errors.generic'), 'error');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('office.suppliers.pay_supplier')}
      description={t('office.suppliers.pay_for', { name: supplierName })}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <MoneyInput
          label={t('office.suppliers.amount')}
          value={amount}
          onChange={setAmount}
        />
        <fieldset>
          <legend className="mb-1 text-small">
            {t('office.suppliers.method')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {(['cash', 'bank_wallet', 'card'] as Method[]).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={method === m}
                className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
                onClick={() => setMethod(m)}
              >
                {t(`payment.${m}`)}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-small">
          {t('office.suppliers.reference')}
          <input
            className={field}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.suppliers.note')}
          <input
            className={field}
            value={note}
            maxLength={120}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>
      <p className="text-small text-text-muted">
        {t('office.suppliers.balance_after', {
          amount: formatShopMoney(balance - (amount ?? 0)),
        })}
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={buttonQuiet}
          onClick={() => onOpenChange(false)}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={buttonPrimary}
          disabled={!amount || amount <= 0 || pending}
          onClick={() => void save()}
        >
          {t('office.suppliers.save_payment')}
        </button>
      </div>
    </Modal>
  );
}
