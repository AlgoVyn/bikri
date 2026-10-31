import { newId } from '@bikri/core';
import { Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { cashMove, ExpenseError } from '../data/expenses.ts';
import { formatShopMoney } from '../lib/money';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

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
          { amount: formatShopMoney(amount) },
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
      <Stack gap="sm">
        <Group gap="xs">
          <Button
            type="button"
            size="compact-sm"
            variant={kind === 'pay_in' ? 'light' : 'default'}
            aria-pressed={kind === 'pay_in'}
            onClick={() => setKind('pay_in')}
          >
            {t('office.expenses.pay_in')}
          </Button>
          <Button
            type="button"
            size="compact-sm"
            variant={kind === 'pay_out' ? 'light' : 'default'}
            aria-pressed={kind === 'pay_out'}
            onClick={() => setKind('pay_out')}
          >
            {t('office.expenses.pay_out')}
          </Button>
        </Group>
        <MoneyInput
          label={t('office.expenses.amount')}
          value={amount}
          onChange={setAmount}
        />
        <TextInput
          label={t('office.expenses.reason')}
          maxLength={120}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
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
            disabled={!amount || amount <= 0 || reason.trim() === '' || pending}
            loading={pending}
            onClick={() => void save()}
          >
            {t('office.expenses.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
