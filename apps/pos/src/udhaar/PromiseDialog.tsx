import { businessDate } from '@bikri/core';
import {
  Button,
  Group,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { createPromise, PromiseError } from '../data/udhaar.ts';
import { formatShopMoney } from '../lib/money';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

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
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDate(businessDate(Date.now()));
    setAmount(null);
    setNote('');
    setPending(false);
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
      if (err instanceof PromiseError)
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
    >
      <Stack gap="sm">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <TextInput
            type="date"
            label={t('office.udhaar.promise_date')}
            min={businessDate(Date.now())}
            value={date}
            onChange={(event) => setDate(event.currentTarget.value)}
          />
          <MoneyInput
            label={t('office.udhaar.promise_amount')}
            value={amount}
            onChange={setAmount}
          />
        </SimpleGrid>
        <Text size="sm" c="dimmed">
          {t('office.udhaar.promise_whole', {
            amount: formatShopMoney(balance),
          })}
        </Text>
        <TextInput
          label={t('office.udhaar.note')}
          value={note}
          maxLength={120}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
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
            disabled={pending || date === ''}
            loading={pending}
            onClick={() => void save()}
          >
            {t('office.udhaar.save_promise')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
