import { businessDate, newId } from '@bikri/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ExpensesIcon } from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import {
  ExpenseError,
  type ExpenseRow,
  expenseList,
  expensesCsv,
  reverseExpense,
} from '../data/expenses.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { downloadText } from '../lib/download.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { CashMoveDialog } from './CashMoveDialog.tsx';
import { ExpenseDialog } from './ExpenseDialog.tsx';
import { categoryName, dateText, timeText } from './format.ts';

type Preset = 'today' | '7d' | '30d' | 'month';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Expenses list (screens/14). */
export function ExpensesPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { staff, role, can } = useCurrentStaff();
  const [preset, setPreset] = useState<Preset>('month');
  const [newOpen, setNewOpen] = useState(false);
  const [cashOpen, setCashOpen] = useState(false);
  const [reversing, setReversing] = useState<ExpenseRow | null>(null);
  const [today, setToday] = useState(businessDate(Date.now()));
  const [tz, setTz] = useState('Asia/Karachi');

  useEffect(() => {
    void (async () => {
      const zone = await shopTimeZone(getDb());
      setTz(zone);
      setToday(businessDate(Date.now(), zone));
    })();
  }, []);

  const range = (() => {
    if (preset === 'today') return { from: today, to: today };
    if (preset === '7d') return { from: addDays(today, -6), to: today };
    if (preset === '30d') return { from: addDays(today, -29), to: today };
    return { from: `${today.slice(0, 7)}-01`, to: today };
  })();

  const data = useLiveQuery(
    () => expenseList(getDb(), range),
    [range.from, range.to],
  );

  useHotkey(plainKey('n'), () => setNewOpen(true), {
    enabled: can('expense.create'),
  });

  const canReverse = (row: ExpenseRow) =>
    can('expense.create') &&
    !row.reversed &&
    !row.expense.reverses_id &&
    (role !== 'cashier' || String(row.expense.business_date) === today);

  const reverse = async () => {
    if (!reversing) return;
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      await reverseExpense(
        db,
        {
          expenseId: String(reversing.expense.id),
          reversalId: newId(),
        },
        ctx,
        { role, today },
      );
      toast.push(t('office.expenses.reversed_done'));
    } catch (err) {
      toast.push(
        err instanceof ExpenseError
          ? t(`office.expenses.expense_error_${err.code}`)
          : t('errors.generic'),
        'error',
      );
    } finally {
      setReversing(null);
    }
  };

  const presets: Preset[] = ['today', '7d', '30d', 'month'];
  const max = Math.max(1, ...(data?.byCategory.map((c) => c.net) ?? [1]));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-h1 font-semibold">
          {t('office.expenses.title')}
        </h1>
        {can('cash.move') ? (
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => setCashOpen(true)}
          >
            {t('office.expenses.cash_in_out')}
          </button>
        ) : null}
        {can('export.data') ? (
          <button
            type="button"
            className={buttonQuiet}
            disabled={!data || data.rows.length === 0}
            onClick={() =>
              data &&
              downloadText('bikri-expenses.csv', expensesCsv(data.rows, tz))
            }
          >
            {t('office.expenses.export_csv')}
          </button>
        ) : null}
        {can('expense.create') ? (
          <button
            type="button"
            className={`${buttonPrimary} gap-2`}
            onClick={() => setNewOpen(true)}
          >
            {t('office.expenses.new_expense')} <KeyBadge keys="N" />
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={preset === p}
            className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
            onClick={() => setPreset(p)}
          >
            {t(`office.expenses.range_${p}`)}
          </button>
        ))}
        <p className="ms-auto self-center text-small">
          {t('office.expenses.total')}:{' '}
          <span className="text-title font-semibold">
            <MoneyText paisa={data?.total ?? 0} />
          </span>
        </p>
      </div>

      {data && data.byCategory.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-card border border-border bg-surface p-3">
          {data.byCategory.map((row) => (
            <div
              key={row.category?.id ?? 'none'}
              className="flex items-center gap-2 text-small"
            >
              <span className="min-w-32 truncate">
                {categoryName(row.category, i18n.language)}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                <span
                  className="block h-full bg-primary"
                  style={{ width: `${Math.round((row.net / max) * 100)}%` }}
                />
              </span>
              <MoneyText paisa={row.net} />
            </div>
          ))}
        </div>
      ) : null}

      {data && data.rows.length === 0 ? (
        <EmptyState
          icon={<ExpensesIcon />}
          message={t('office.expenses.empty')}
          actionLabel={
            can('expense.create') ? t('office.expenses.new_expense') : undefined
          }
          onAction={can('expense.create') ? () => setNewOpen(true) : undefined}
        />
      ) : null}

      {data?.days.map((day) => (
        <section key={day.date} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
            <h2 className="text-title font-semibold">
              {dateText(day.date, i18n.language, tz)}
            </h2>
            <p className="text-small text-text-muted">
              <MoneyText paisa={day.total} />
            </p>
          </div>
          <ul className="flex flex-col rounded-card border border-border bg-surface">
            {day.rows.map((row) => (
              <li
                key={row.expense.id}
                data-testid="expense-row"
                className={`flex flex-wrap items-center gap-2 border-b border-border p-2 last:border-0 ${row.expense.reverses_id ? 'text-text-muted line-through' : ''}`}
              >
                <span className="min-w-0 flex-[2_1_10rem]">
                  <span className="block truncate font-medium">
                    {categoryName(row.category, i18n.language)}
                    {row.expense.reverses_id
                      ? ` · ${t('office.expenses.reversal')}`
                      : ''}
                  </span>
                  <span className="block truncate text-small text-text-muted">
                    {[row.expense.payee, row.expense.note]
                      .filter(Boolean)
                      .map(String)
                      .join(' · ')}
                  </span>
                </span>
                <span className="text-small text-text-muted">
                  {timeText(Number(row.expense.created_at), i18n.language, tz)}
                  {row.staffName ? ` · ${row.staffName}` : ''}
                </span>
                <span className="min-w-24 text-end font-medium">
                  {row.expense.reverses_id ? '−' : ''}
                  <MoneyText paisa={Number(row.expense.amount)} />
                </span>
                <span className="text-small text-text-muted">
                  {t(
                    row.expense.method === 'cash'
                      ? 'payment.cash'
                      : row.expense.method === 'card'
                        ? 'payment.card'
                        : 'payment.bank_wallet',
                  )}
                </span>
                {canReverse(row) ? (
                  <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() => setReversing(row)}
                  >
                    {t('office.expenses.reverse')}
                  </button>
                ) : row.reversed ? (
                  <span className="text-small text-text-muted">
                    {t('office.expenses.reversed')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <ExpenseDialog open={newOpen} onOpenChange={setNewOpen} />
      <CashMoveDialog open={cashOpen} onOpenChange={setCashOpen} />
      <ConfirmDialog
        open={reversing !== null}
        onOpenChange={(open) => {
          if (!open) setReversing(null);
        }}
        title={t('office.expenses.reverse_title')}
        body={t('office.expenses.reverse_body')}
        confirmLabel={t('office.expenses.reverse')}
        onConfirm={() => void reverse()}
      />
    </div>
  );
}
