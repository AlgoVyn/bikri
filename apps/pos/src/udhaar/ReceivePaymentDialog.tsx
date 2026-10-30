import { businessDate, newId } from '@bikri/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { PaymentError, receivePayment } from '../data/udhaar.ts';
import { formatShopMoney } from '../lib/money';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

type PayMethod = 'cash' | 'card' | 'bank_wallet';
const METHODS: PayMethod[] = ['cash', 'bank_wallet', 'card'];
const PROVIDERS = [
  'JazzCash',
  'Easypaisa',
  'NayaPay',
  'Bank transfer',
  'Other',
] as const;

const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

/** Receive money from a customer (screens/12). */
export function ReceivePaymentDialog({
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
  const { staff, role, can } = useCurrentStaff();
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<PayMethod>('cash');
  const [provider, setProvider] = useState<string>(PROVIDERS[0]);
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(businessDate(Date.now()));
  const [note, setNote] = useState('');
  const [paymentId, setPaymentId] = useState(() => newId());
  const [pending, setPending] = useState(false);
  const [overpay, setOverpay] = useState(false);
  const zones = useLiveQuery(async () => {
    const tz = await shopTimeZone(getDb());
    return { tz, today: businessDate(Date.now(), tz) };
  }, []);
  const today = zones?.today ?? businessDate(Date.now());
  const minDate = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();

  useEffect(() => {
    if (!open) return;
    setAmount(Math.max(0, balance));
    setMethod('cash');
    setProvider(PROVIDERS[0]);
    setReference('');
    setDate(today);
    setNote('');
    setPaymentId(newId());
    setOverpay(false);
    setPending(false);
  }, [open, balance, today]);

  const after = balance - (amount ?? 0);
  const over = (amount ?? 0) > Math.max(0, balance);

  const save = async () => {
    if (!amount || amount <= 0 || pending || !can('payment.receive')) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      await receivePayment(
        db,
        {
          paymentId,
          customerId,
          amount,
          method,
          provider: method === 'bank_wallet' ? provider : '',
          reference,
          date,
          note,
        },
        ctx,
        { role, today },
      );
      toast.push(
        t('office.udhaar.payment_saved', { amount: formatShopMoney(amount) }),
      );
      onOpenChange(false);
    } catch (err) {
      if (err instanceof PaymentError)
        toast.push(t(`office.udhaar.payment_error_${err.code}`), 'error');
      else toast.push(t('errors.generic'), 'error');
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={t('office.udhaar.receive_money')}
        description={t('office.udhaar.receive_for', { name: customerName })}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <MoneyInput
            label={t('office.udhaar.amount')}
            value={amount}
            onChange={setAmount}
          />
          <label className="flex flex-col gap-1 text-small">
            {t('office.udhaar.payment_date')}
            <input
              type="date"
              className={field}
              min={minDate}
              max={today}
              value={date}
              disabled={role !== 'owner'}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-small">
              {t('office.udhaar.method')}
            </legend>
            <div className="flex flex-wrap gap-2">
              {METHODS.map((m) => (
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
          {method === 'bank_wallet' ? (
            <>
              <label className="flex flex-col gap-1 text-small">
                {t('office.udhaar.provider')}
                <select
                  className={field}
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-small">
                {t('office.udhaar.reference')}
                <input
                  className={field}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
            </>
          ) : null}
          {method === 'card' ? (
            <label className="flex flex-col gap-1 text-small sm:col-span-2">
              {t('office.udhaar.reference')}
              <input
                className={field}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-small sm:col-span-2">
            {t('office.udhaar.note')}
            <input
              className={field}
              value={note}
              maxLength={120}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
        <p className="text-small" data-testid="payment-after">
          {after >= 0
            ? t('office.udhaar.balance_after', {
                amount: formatShopMoney(after),
              })
            : t('office.udhaar.credit_after', {
                amount: formatShopMoney(-after),
              })}
        </p>
        {role !== 'owner' ? (
          <p className="text-small text-text-muted">
            {t('office.udhaar.payment_backdate_owner')}
          </p>
        ) : null}
        {!can('payment.receive') ? (
          <p role="alert" className="text-danger">
            {t('office.udhaar.payment_no_permission')}
          </p>
        ) : null}
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
            disabled={
              !amount || amount <= 0 || pending || !can('payment.receive')
            }
            onClick={() => {
              if (over) setOverpay(true);
              else void save();
            }}
          >
            {t('office.udhaar.save_payment')}
          </button>
        </div>
      </Modal>
      <ConfirmDialog
        open={overpay}
        onOpenChange={setOverpay}
        title={t('office.udhaar.overpay_title')}
        body={t('office.udhaar.overpay_body', {
          amount: formatShopMoney((amount ?? 0) - Math.max(0, balance)),
        })}
        confirmLabel={t('office.udhaar.overpay_confirm')}
        onConfirm={() => void save()}
      />
    </>
  );
}
