import { businessDate } from '@bikri/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { DateField } from '../components/DateField.tsx';
import { DialogFooter } from '../components/DialogFooter.tsx';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { createPromise, PromiseError } from '../data/udhaar.ts';
import { ReadOnlyError } from '../data/write.ts';
import { formatShopMoney } from '../lib/money';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

/** Add a promise to pay (screens/12). */
export function PromiseDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  balance,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  balance: number;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const [date, setDate] = useState(businessDate(Date.now()));
  const [tz, setTz] = useState('Asia/Karachi');
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount(null);
    setNote('');
    setPending(false);
    // The shop's business date can differ from Karachi's; seed and bound the field with it.
    void shopTimeZone(getDb())
      .then((zone) => {
        setTz(zone);
        setDate(businessDate(Date.now(), zone));
      })
      .catch(() => undefined);
  }, [open]);

  const save = async () => {
    if (pending) return;
    setPending(true);
    try {
      const db = getDb();
      const tz = await shopTimeZone(db);
      await createPromise(
        db,
        {
          customerId,
          promisedOn: date,
          amount,
          note,
        },
        staff?.id ?? null,
        { today: businessDate(Date.now(), tz) },
      );
      toast.push(t('office.udhaar.promise_saved'));
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ReadOnlyError)
        toast.push(t('tenant.readOnly.blocked'), 'error');
      else if (err instanceof PromiseError)
        toast.push(t(`office.udhaar.promise_error_${err.code}`), 'error');
      else toast.push(t('errors.generic'), 'error');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('office.udhaar.add_promise')}
      description={t('office.udhaar.promise_for', { name: customerName })}
      sheet
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <DateField
          label={t('office.udhaar.promise_date')}
          value={date}
          min={businessDate(Date.now(), tz)}
          onChange={setDate}
        />
        <MoneyInput
          label={t('office.udhaar.promise_amount')}
          value={amount}
          onChange={setAmount}
        />
      </div>
      <p className="text-small text-text-muted">
        {t('office.udhaar.promise_whole', { amount: formatShopMoney(balance) })}
      </p>
      <label className="flex flex-col gap-1 text-small">
        {t('office.udhaar.note')}
        <input
          className={field}
          value={note}
          maxLength={120}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
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
          disabled={pending || date === ''}
          onClick={() => void save()}
        >
          {t('office.udhaar.save_promise')}
        </button>
      </DialogFooter>
    </Modal>
  );
}
