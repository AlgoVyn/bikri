import { formatMoney, newId } from '@bikri/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { cashMove, ExpenseError } from '../data/expenses.ts';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

/** Pay-in / pay-out dialog (screens/14). */
export function CashMoveDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const [kind, setKind] = useState<'pay_in' | 'pay_out'>('pay_in');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [id, setId] = useState(() => newId());
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind('pay_in');
    setAmount(null);
    setReason('');
    setId(newId());
    setPending(false);
  }, [open]);

  const save = async () => {
    if (!amount || amount <= 0 || reason.trim() === '' || pending) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      await cashMove(db, { cashMoveId: id, kind, amount, reason }, ctx);
      toast.push(
        t(
          kind === 'pay_in'
            ? 'office.expenses.cash_in_saved'
            : 'office.expenses.cash_out_saved',
          { amount: formatMoney(amount) },
        ),
      );
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ExpenseError)
        toast.push(t(`office.expenses.cash_error_${err.code}`), 'error');
      else toast.push(t('errors.generic'), 'error');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('office.expenses.cash_title')}
    >
      <div className="flex gap-2">
        <button
          type="button"
          aria-pressed={kind === 'pay_in'}
          className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
          onClick={() => setKind('pay_in')}
        >
          {t('office.expenses.pay_in')}
        </button>
        <button
          type="button"
          aria-pressed={kind === 'pay_out'}
          className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
          onClick={() => setKind('pay_out')}
        >
          {t('office.expenses.pay_out')}
        </button>
      </div>
      <div className="flex flex-col gap-2">
        <MoneyInput
          label={t('office.expenses.amount')}
          value={amount}
          onChange={setAmount}
        />
        <label className="flex flex-col gap-1 text-small">
          {t('office.expenses.reason')}
          <input
            className={field}
            maxLength={120}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>
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
          disabled={!amount || amount <= 0 || reason.trim() === '' || pending}
          onClick={() => void save()}
        >
          {t('office.expenses.save')}
        </button>
      </div>
    </Modal>
  );
}
