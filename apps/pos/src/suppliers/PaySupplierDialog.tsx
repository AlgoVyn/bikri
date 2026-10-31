import { newId } from '@bikri/core';
import {
  Box,
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
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { paySupplier, SupplierPaymentError } from '../data/purchases.ts';
import { formatShopMoney } from '../lib/money';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

type Method = 'cash' | 'card' | 'bank_wallet';

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
      <Stack gap="sm">
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <MoneyInput
            label={t('office.suppliers.amount')}
            value={amount}
            onChange={setAmount}
          />
          <Box
            component="fieldset"
            style={{ border: 0, margin: 0, padding: 0 }}
          >
            <Text component="legend" size="sm" mb={4}>
              {t('office.suppliers.method')}
            </Text>
            <Group gap="xs">
              {(['cash', 'bank_wallet', 'card'] as Method[]).map((m) => (
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
          <TextInput
            label={t('office.suppliers.reference')}
            value={reference}
            onChange={(event) => setReference(event.currentTarget.value)}
          />
          <TextInput
            label={t('office.suppliers.note')}
            value={note}
            maxLength={120}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </SimpleGrid>
        <Text size="sm" c="dimmed">
          {t('office.suppliers.balance_after', {
            amount: formatShopMoney(balance - (amount ?? 0)),
          })}
        </Text>
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
            disabled={!amount || amount <= 0 || pending}
            loading={pending}
            onClick={() => void save()}
          >
            {t('office.suppliers.save_payment')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
