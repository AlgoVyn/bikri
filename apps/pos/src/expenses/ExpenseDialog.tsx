import { businessDate, newId } from '@bikri/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
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

const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

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
        <fieldset>
          <legend className="mb-1 text-small">
            {t('office.expenses.category')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                aria-pressed={categoryId === category.id}
                className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
                onClick={() => setCategoryId(category.id)}
              >
                {categoryName(category, i18n.language)}
              </button>
            ))}
            {role === 'owner' ? (
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => setCategoryOpen(true)}
              >
                {t('office.expenses.category_add')}
              </button>
            ) : null}
          </div>
        </fieldset>
        <div className="grid gap-2 sm:grid-cols-2">
          <MoneyInput
            label={t('office.expenses.amount')}
            value={amount}
            onChange={setAmount}
          />
          <label className="flex flex-col gap-1 text-small">
            {t('office.expenses.date')}
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
              {t('office.expenses.method')}
            </legend>
            <div className="flex flex-wrap gap-2">
              {(['cash', 'bank_wallet', 'card'] as ExpenseMethod[]).map((m) => (
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
            {t('office.expenses.payee')}
            <input
              className={field}
              maxLength={60}
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-small">
            {t('office.expenses.note')}
            <input
              className={field}
              maxLength={120}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
        {overLimit ? (
          <div className="rounded-control bg-warning-subtle p-2 text-small text-warning-subtle-ink">
            <p>{t('office.expenses.limit_message')}</p>
            {!override ? (
              <button
                type="button"
                className="underline"
                onClick={() => setApproving(true)}
              >
                {t('office.expenses.ask_manager')}
              </button>
            ) : (
              <p>{t('office.expenses.override_ok')}</p>
            )}
          </div>
        ) : null}
        {role !== 'owner' ? (
          <p className="text-small text-text-muted">
            {t('office.expenses.backdate_owner')}
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
              !amount ||
              amount <= 0 ||
              !categoryId ||
              pending ||
              (overLimit && !override)
            }
            onClick={() => void save(override)}
          >
            {t('office.expenses.save')}
          </button>
        </div>
        {!can('expense.create') ? (
          <p role="alert" className="text-danger">
            {t('office.expenses.no_permission')}
          </p>
        ) : null}
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
