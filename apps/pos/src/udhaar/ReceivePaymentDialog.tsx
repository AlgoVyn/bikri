import { businessDate, newId } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  NativeSelect,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
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
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <MoneyInput
              label={t('office.udhaar.amount')}
              value={amount}
              onChange={setAmount}
            />
            <TextInput
              type="date"
              label={t('office.udhaar.payment_date')}
              min={minDate}
              max={today}
              value={date}
              disabled={role !== 'owner'}
              onChange={(event) => setDate(event.currentTarget.value)}
            />
            <Box
              component="fieldset"
              style={{
                border: 0,
                margin: 0,
                padding: 0,
                gridColumn: '1 / -1',
              }}
            >
              <Text component="legend" size="sm" mb={4}>
                {t('office.udhaar.method')}
              </Text>
              <Group gap="xs">
                {METHODS.map((m) => (
                  <Button
                    key={m}
                    type="button"
                    size="compact-sm"
                    variant={method === m ? 'light' : 'default'}
                    aria-pressed={method === m}
                    onClick={() => setMethod(m)}
                  >
                    {t(`payment.${m}`)}
                  </Button>
                ))}
              </Group>
            </Box>
            {method === 'bank_wallet' ? (
              <>
                <NativeSelect
                  label={t('office.udhaar.provider')}
                  value={provider}
                  onChange={(event) => setProvider(event.currentTarget.value)}
                  data={PROVIDERS.map((p) => ({ value: p, label: p }))}
                />
                <TextInput
                  label={t('office.udhaar.reference')}
                  value={reference}
                  onChange={(event) => setReference(event.currentTarget.value)}
                />
              </>
            ) : null}
            {method === 'card' ? (
              <Box style={{ gridColumn: '1 / -1' }}>
                <TextInput
                  label={t('office.udhaar.reference')}
                  value={reference}
                  onChange={(event) => setReference(event.currentTarget.value)}
                />
              </Box>
            ) : null}
            <Box style={{ gridColumn: '1 / -1' }}>
              <TextInput
                label={t('office.udhaar.note')}
                value={note}
                maxLength={120}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
            </Box>
          </SimpleGrid>
          <Text size="sm" data-testid="payment-after">
            {after >= 0
              ? t('office.udhaar.balance_after', {
                  amount: formatShopMoney(after),
                })
              : t('office.udhaar.credit_after', {
                  amount: formatShopMoney(-after),
                })}
          </Text>
          {role !== 'owner' ? (
            <Text size="sm" c="dimmed">
              {t('office.udhaar.payment_backdate_owner')}
            </Text>
          ) : null}
          {!can('payment.receive') ? (
            <Text role="alert" c="danger" size="sm">
              {t('office.udhaar.payment_no_permission')}
            </Text>
          ) : null}
          <Group justify="flex-end" gap="sm">
            <Button
              type="button"
              variant="default"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={
                !amount || amount <= 0 || pending || !can('payment.receive')
              }
              loading={pending}
              onClick={() => {
                if (over) setOverpay(true);
                else void save();
              }}
            >
              {t('office.udhaar.save_payment')}
            </Button>
          </Group>
        </Stack>
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
