import { businessDate, newId } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  Paper,
  Progress,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ExpensesIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
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
import { readDateFilter, rememberDateFilter } from '../lib/dateFilter.ts';
import { downloadText } from '../lib/download.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { CashMoveDialog } from './CashMoveDialog.tsx';
import { ExpenseDialog } from './ExpenseDialog.tsx';
import { categoryName, dateText, timeText } from './format.ts';

type Preset = 'today' | '7d' | '30d' | 'month' | 'last_month' | 'custom';

const PRESETS: Preset[] = [
  'today',
  '7d',
  '30d',
  'month',
  'last_month',
  'custom',
];

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
  const readOnly = useReadOnly();
  const [stored] = useState(() =>
    readDateFilter('expenses', PRESETS, 'month', businessDate(Date.now())),
  );
  const [preset, setPreset] = useState<Preset>(stored.preset);
  const [custom, setCustom] = useState({
    from: stored.from,
    to: stored.to,
  });
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

  const customValid = custom.from <= custom.to;
  const range = (() => {
    if (preset === 'today') return { from: today, to: today };
    if (preset === '7d') return { from: addDays(today, -6), to: today };
    if (preset === '30d') return { from: addDays(today, -29), to: today };
    if (preset === 'last_month') {
      const [year = 1970, month = 1] = today.split('-').map(Number);
      const first = new Date(Date.UTC(year, month - 2, 1));
      const last = new Date(Date.UTC(year, month - 1, 0));
      return {
        from: first.toISOString().slice(0, 10),
        to: last.toISOString().slice(0, 10),
      };
    }
    if (preset === 'custom')
      return customValid ? custom : { from: today, to: today };
    return { from: `${today.slice(0, 7)}-01`, to: today };
  })();

  useEffect(() => {
    rememberDateFilter('expenses', preset, custom.from, custom.to);
  }, [preset, custom.from, custom.to]);

  const data = useLiveQuery(
    () => expenseList(getDb(), range),
    [range.from, range.to],
  );

  useHotkey(plainKey('n'), () => setNewOpen(true), {
    enabled: can('expense.create') && !readOnly,
  });

  const canReverse = (row: ExpenseRow) =>
    can('expense.create') &&
    !readOnly &&
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

  const max = Math.max(1, ...(data?.byCategory.map((c) => c.net) ?? [1]));

  return (
    <Box mx="auto" maw={1152} p="md" w="100%">
      <Stack gap="sm">
        <PageHeader
          icon={<ExpensesIcon />}
          tone="bg-warning-subtle text-warning-subtle-ink"
          title={t('office.expenses.title')}
          subtitle={t('office.expenses.subtitle')}
          actions={
            <>
              {can('cash.move') ? (
                <Button
                  type="button"
                  variant="default"
                  disabled={readOnly}
                  onClick={() => setCashOpen(true)}
                >
                  {t('office.expenses.cash_in_out')}
                </Button>
              ) : null}
              {can('export.data') ? (
                <Button
                  type="button"
                  variant="default"
                  disabled={!data || data.rows.length === 0}
                  onClick={() =>
                    data &&
                    downloadText(
                      'bikri-expenses.csv',
                      expensesCsv(data.rows, tz),
                    )
                  }
                >
                  {t('office.expenses.export_csv')}
                </Button>
              ) : null}
              {can('expense.create') ? (
                <Button
                  type="button"
                  disabled={readOnly}
                  onClick={() => setNewOpen(true)}
                >
                  {t('office.expenses.new_expense')}
                </Button>
              ) : null}
            </>
          }
        />

        <Paper withBorder p="sm">
          <Group gap="xs" align="flex-end">
            {PRESETS.map((p) => (
              <Button
                key={p}
                type="button"
                size="compact-sm"
                variant={preset === p ? 'light' : 'default'}
                aria-pressed={preset === p}
                onClick={() => setPreset(p)}
              >
                {t(`office.expenses.range_${p}`)}
              </Button>
            ))}
            {preset === 'custom' ? (
              <>
                <TextInput
                  type="date"
                  label={t('office.expenses.from')}
                  value={custom.from}
                  max={custom.to}
                  onChange={(event) =>
                    setCustom((current) => ({
                      ...current,
                      from: event.currentTarget.value,
                    }))
                  }
                />
                <TextInput
                  type="date"
                  label={t('office.expenses.to')}
                  value={custom.to}
                  min={custom.from}
                  onChange={(event) =>
                    setCustom((current) => ({
                      ...current,
                      to: event.currentTarget.value,
                    }))
                  }
                />
              </>
            ) : null}
            <Group gap={6} align="baseline" ms="auto">
              <Text size="sm">{t('office.expenses.total')}:</Text>
              <Text fz={22} fw={600}>
                <MoneyText paisa={data?.total ?? 0} />
              </Text>
            </Group>
          </Group>
          {preset === 'custom' && !customValid ? (
            <Text size="sm" c="danger" role="alert" mt="xs">
              {t('office.expenses.range_invalid')}
            </Text>
          ) : null}
        </Paper>

        {data && data.byCategory.length > 0 ? (
          <Paper withBorder p="sm">
            <Stack gap="xs">
              {data.byCategory.map((row) => (
                <Group key={row.category?.id ?? 'none'} gap="sm" wrap="nowrap">
                  <Text size="sm" w={128} truncate>
                    {categoryName(row.category, i18n.language)}
                  </Text>
                  <Box style={{ flex: 1 }}>
                    <Progress
                      value={Math.round((row.net / max) * 100)}
                      size="sm"
                      color="brand"
                      aria-label={`${categoryName(row.category, i18n.language)} ${Math.round((row.net / max) * 100)}%`}
                    />
                  </Box>
                  <Text size="sm">
                    <MoneyText paisa={row.net} />
                  </Text>
                </Group>
              ))}
            </Stack>
          </Paper>
        ) : null}

        {data && data.rows.length === 0 ? (
          <EmptyState
            icon={<ExpensesIcon />}
            message={t('office.expenses.empty')}
            actionLabel={
              can('expense.create')
                ? t('office.expenses.new_expense')
                : undefined
            }
            onAction={
              can('expense.create') && !readOnly
                ? () => setNewOpen(true)
                : undefined
            }
          />
        ) : null}

        {data?.days.map((day) => (
          <Box component="section" key={day.date}>
            <Stack gap={4}>
              <Group
                justify="space-between"
                align="baseline"
                gap="sm"
                wrap="wrap"
                pb={4}
                style={{
                  borderBottom: '1px solid var(--mantine-color-default-border)',
                }}
              >
                <Title order={2} fz="md">
                  {dateText(day.date, i18n.language, tz)}
                </Title>
                <Text size="sm" c="dimmed">
                  <MoneyText paisa={day.total} />
                </Text>
              </Group>
              <Paper withBorder p={0}>
                <Box
                  component="ul"
                  style={{ listStyle: 'none', margin: 0, padding: 0 }}
                >
                  {day.rows.map((row, index) => (
                    <Box
                      component="li"
                      key={row.expense.id}
                      data-testid="expense-row"
                      style={{
                        borderTop:
                          index > 0
                            ? '1px solid var(--mantine-color-default-border)'
                            : undefined,
                      }}
                    >
                      <Group
                        gap="sm"
                        p="sm"
                        wrap="wrap"
                        opacity={row.expense.reverses_id ? 0.65 : undefined}
                        style={
                          row.expense.reverses_id
                            ? { textDecoration: 'line-through' }
                            : undefined
                        }
                      >
                        <Box style={{ flex: '2 1 10rem', minWidth: 0 }}>
                          <Text size="sm" fw={500} truncate>
                            {categoryName(row.category, i18n.language)}
                            {row.expense.reverses_id
                              ? ` · ${t('office.expenses.reversal')}`
                              : ''}
                          </Text>
                          <Text size="sm" c="dimmed" truncate>
                            {[row.expense.payee, row.expense.note]
                              .filter(Boolean)
                              .map(String)
                              .join(' · ')}
                          </Text>
                        </Box>
                        <Text size="sm" c="dimmed">
                          {timeText(
                            Number(row.expense.created_at),
                            i18n.language,
                            tz,
                          )}
                          {row.staffName ? ` · ${row.staffName}` : ''}
                        </Text>
                        <Text size="sm" fw={500} ta="end" w={96}>
                          {row.expense.reverses_id ? '−' : ''}
                          <MoneyText paisa={Number(row.expense.amount)} />
                        </Text>
                        <Text size="sm" c="dimmed">
                          {t(
                            row.expense.method === 'cash'
                              ? 'payment.cash'
                              : row.expense.method === 'card'
                                ? 'payment.card'
                                : 'payment.bank_wallet',
                          )}
                        </Text>
                        {canReverse(row) ? (
                          <Button
                            type="button"
                            size="compact-sm"
                            variant="default"
                            onClick={() => setReversing(row)}
                          >
                            {t('office.expenses.reverse')}
                          </Button>
                        ) : row.reversed ? (
                          <Text size="sm" c="dimmed">
                            {t('office.expenses.reversed')}
                          </Text>
                        ) : null}
                      </Group>
                    </Box>
                  ))}
                </Box>
              </Paper>
            </Stack>
          </Box>
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
      </Stack>
    </Box>
  );
}
