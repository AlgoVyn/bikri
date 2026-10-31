import { businessDate, newId } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import {
  CASHIER_EXPENSE_LIMIT,
  createExpense,
  ExpenseError,
  type ExpenseMethod,
  expenseCategories,
} from '../data/expenses.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { ApprovalDialog } from '../sales/ApprovalDialog.tsx';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { CategoryDialog } from './CategoryDialog.tsx';
import { categoryName } from './format.ts';

/** New expense (screens/14). */
export function ExpenseDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { staff, role, can } = useCurrentStaff();
  const categories = useLiveQuery(() => expenseCategories(getDb()), []) ?? [];
  const zone = useLiveQuery(async () => {
    const tz = await shopTimeZone(getDb());
    return { tz, today: businessDate(Date.now(), tz) };
  }, []);
  const today = zone?.today ?? businessDate(Date.now());
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<ExpenseMethod>('cash');
  const [payee, setPayee] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today);
  const [expenseId, setExpenseId] = useState(() => newId());
  const [override, setOverride] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCategoryId(categories[0]?.id ?? '');
    setAmount(null);
    setMethod('cash');
    setPayee('');
    setNote('');
    setDate(today);
    setExpenseId(newId());
    setOverride(null);
    setApproving(false);
    setPending(false);
  }, [open, today, categories]);

  const minDate = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  const overLimit =
    role === 'cashier' &&
    (method !== 'cash' || (amount ?? 0) > CASHIER_EXPENSE_LIMIT);

  const save = async (approvedBy: string | null) => {
    if (!amount || amount <= 0 || !categoryId || pending) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      await createExpense(
        db,
        {
          expenseId,
          categoryId,
          amount,
          method,
          payee,
          note,
          date,
        },
        ctx,
        {
          role,
          today,
          override: approvedBy ? { approved_by: approvedBy } : null,
        },
      );
      toast.push(t('office.expenses.expense_saved'));
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ExpenseError)
        toast.push(t(`office.expenses.expense_error_${err.code}`), 'error');
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
        title={t('office.expenses.new_expense')}
        description={t('office.expenses.supplier_hint')}
      >
        <Stack gap="sm">
          <Box
            component="fieldset"
            style={{ border: 0, margin: 0, padding: 0 }}
          >
            <Text component="legend" size="sm" mb={4}>
              {t('office.expenses.category')}
            </Text>
            <Group gap="xs">
              {categories.map((category) => (
                <Button
                  key={category.id}
                  type="button"
                  size="compact-sm"
                  variant={categoryId === category.id ? 'light' : 'default'}
                  aria-pressed={categoryId === category.id}
                  onClick={() => setCategoryId(category.id)}
                >
                  {categoryName(category, i18n.language)}
                </Button>
              ))}
              {role === 'owner' ? (
                <Button
                  type="button"
                  size="compact-sm"
                  variant="default"
                  onClick={() => setCategoryOpen(true)}
                >
                  {t('office.expenses.category_add')}
                </Button>
              ) : null}
            </Group>
          </Box>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <MoneyInput
              label={t('office.expenses.amount')}
              value={amount}
              onChange={setAmount}
            />
            <TextInput
              type="date"
              label={t('office.expenses.date')}
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
                {t('office.expenses.method')}
              </Text>
              <Group gap="xs">
                {(['cash', 'bank_wallet', 'card'] as ExpenseMethod[]).map(
                  (m) => (
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
                  ),
                )}
              </Group>
            </Box>
            <TextInput
              label={t('office.expenses.payee')}
              maxLength={60}
              value={payee}
              onChange={(event) => setPayee(event.currentTarget.value)}
            />
            <TextInput
              label={t('office.expenses.note')}
              maxLength={120}
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </SimpleGrid>
          {overLimit ? (
            <Paper p="sm" bg="var(--mantine-color-warning-subtle)">
              <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
                {t('office.expenses.limit_message')}
              </Text>
              {!override ? (
                <Button
                  type="button"
                  variant="transparent"
                  size="compact-sm"
                  px={0}
                  onClick={() => setApproving(true)}
                >
                  {t('office.expenses.ask_manager')}
                </Button>
              ) : (
                <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
                  {t('office.expenses.override_ok')}
                </Text>
              )}
            </Paper>
          ) : null}
          {role !== 'owner' ? (
            <Text size="sm" c="dimmed">
              {t('office.expenses.backdate_owner')}
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
                !amount ||
                amount <= 0 ||
                !categoryId ||
                pending ||
                (overLimit && !override)
              }
              loading={pending}
              onClick={() => void save(override)}
            >
              {t('office.expenses.save')}
            </Button>
          </Group>
          {!can('expense.create') ? (
            <Text c="danger" role="alert" size="sm">
              {t('office.expenses.no_permission')}
            </Text>
          ) : null}
        </Stack>
      </Modal>
      <ApprovalDialog
        open={approving}
        onOpenChange={(next) => {
          if (!next) setApproving(false);
        }}
        permission="expense.create"
        roles={['owner', 'manager']}
        body={t('office.expenses.override_body')}
        onApproved={(approvedBy) => {
          setApproving(false);
          setOverride(approvedBy);
        }}
      />
      <CategoryDialog
        open={categoryOpen}
        onOpenChange={setCategoryOpen}
        onSaved={() => undefined}
      />
    </>
  );
}
