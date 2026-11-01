import { newId } from '@bikri/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { DialogFooter } from '../components/DialogFooter.tsx';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
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

  // The balance is a default for a new payment, not a form value: a pull that
  // updates it must not wipe what the owner is typing (or the payment id).
  const balanceAtOpen = useRef(balance);
  balanceAtOpen.current = balance;
  useEffect(() => {
    if (!open) return;
    setAmount(Math.max(0, balanceAtOpen.current));
    setMethod('cash');
    setReference('');
    setNote('');
    setPaymentId(newId());
    setPending(false);
  }, [open]);

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
      sheet
    >
      <p className="flex items-center justify-between gap-2 border-b border-border pb-2 text-small">
        <span className="text-text-muted">
          {balance > 0
            ? t('office.suppliers.you_owe_label')
            : balance < 0
              ? t('office.suppliers.advance_label')
              : t('office.suppliers.settled')}
        </span>
        {balance !== 0 ? (
          <span className="font-medium">
            <MoneyText paisa={Math.abs(balance)} />
          </span>
        ) : null}
      </p>
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
          <div className="grid grid-cols-3 gap-2">
            {(['cash', 'bank_wallet', 'card'] as Method[]).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={method === m}
                className={`min-h-11 rounded-control border px-2 text-small transition-colors duration-150 ${
                  method === m
                    ? 'border-primary bg-primary-subtle font-medium text-primary-subtle-ink'
                    : 'border-border-strong bg-surface text-text-muted hover:bg-surface-2'
                }`}
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
      <p className="text-end text-small tabular-nums text-text-muted">
        {t('office.suppliers.balance_after', {
          amount: formatShopMoney(balance - (amount ?? 0)),
        })}
      </p>
      <DialogFooter>
        <button
          type="button"
          className={`${buttonQuiet} max-md:flex-1`}
          onClick={() => onOpenChange(false)}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={`${buttonPrimary} max-md:flex-1`}
          disabled={!amount || amount <= 0 || pending}
          onClick={() => void save()}
        >
          {t('office.suppliers.save_payment')}
        </button>
      </DialogFooter>
    </Modal>
  );
}
