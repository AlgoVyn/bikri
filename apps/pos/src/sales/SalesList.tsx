import { businessDate } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/EmptyState.tsx';
import { SalesIcon, SearchIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { StatusPill } from '../components/StatusPill.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { queueSalePrint } from '../data/receipt.ts';
import {
  type MethodFilter,
  rangeFor,
  type SaleListRow,
  type SaleStatus,
  type SalesDay,
  type SalesPreset,
  salesCsv,
  salesFilterOptions,
  salesHistory,
  shopTimeZone,
} from '../data/salesHistory.ts';
import { readDateFilter, rememberDateFilter } from '../lib/dateFilter.ts';
import { downloadText } from '../lib/download.ts';
import { rememberListScroll } from '../lib/listScroll.ts';
import { formatShopMoney } from '../lib/money';
import { useCurrentStaff } from '../state/currentStaff.ts';
import {
  dayHeading,
  methodLabel,
  qtyText,
  statusLabel,
  timeText,
} from './format.ts';

const PAGE = 50;
const SALES_PRESETS: SalesPreset[] = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'custom',
];
const SALE_GRID =
  'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[4rem_minmax(0,1.2fr)_minmax(0,1.4fr)_3.5rem_6rem_minmax(0,1.4fr)_7.5rem]';

const PRESETS: { id: SalesPreset; key: string }[] = [
  { id: 'today', key: 'office.sales.range_today' },
  { id: 'yesterday', key: 'office.sales.range_yesterday' },
  { id: '7d', key: 'office.sales.range_7d' },
  { id: '30d', key: 'office.sales.range_30d' },
  { id: 'month', key: 'office.sales.range_month' },
  { id: 'custom', key: 'office.sales.range_custom' },
];

const METHOD_FILTERS: MethodFilter[] = [
  'cash',
  'card',
  'bank_wallet',
  'udhaar',
  'split',
];

const STATUSES: SaleStatus[] = ['paid', 'part_refunded', 'refunded', 'void'];

/** Sales history (screens/10). */
export function SalesList({
  bill,
  embedded = false,
  detailOpen = false,
  selectedId,
}: {
  bill?: string;
  embedded?: boolean;
  detailOpen?: boolean;
  selectedId?: string;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { staff, can } = useCurrentStaff();
  const limited = !can('report.view');
  const now = Date.now();
  const today = businessDate(now);
  const yesterday = businessDate(now - 86_400_000);
  const [stored] = useState(() =>
    readDateFilter('sales', SALES_PRESETS, 'today', today),
  );
  const [preset, setPreset] = useState<SalesPreset>(stored.preset);
  const [custom, setCustom] = useState({
    from: stored.from,
    to: stored.to,
  });
  const [query, setQuery] = useState('');
  const [method, setMethod] = useState<MethodFilter | ''>('');
  const [status, setStatus] = useState<SaleStatus | ''>('');
  const [staffId, setStaffId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const activeFilters = [method, status, staffId, deviceId].filter(
    Boolean,
  ).length;

  useEffect(() => {
    if (bill) void navigate({ to: '/sales/$id', params: { id: bill } });
  }, [bill, navigate]);

  useEffect(() => {
    if (!limited) rememberDateFilter('sales', preset, custom.from, custom.to);
  }, [preset, custom.from, custom.to, limited]);

  const data = useLiveQuery(async () => {
    const db = getDb();
    const timeZone = await shopTimeZone(db);
    const range = limited
      ? rangeFor('today', Date.now(), timeZone)
      : rangeFor(preset, Date.now(), timeZone, custom);
    const history = await salesHistory(db, {
      ...range,
      query,
      method: method || null,
      status: status || null,
      staffId: staffId || null,
      deviceId: deviceId || null,
      branchId: limited && staff?.branch_id ? String(staff.branch_id) : null,
    });
    return { ...history, timeZone, range };
  }, [
    preset,
    custom.from,
    custom.to,
    query,
    method,
    status,
    staffId,
    deviceId,
    limited,
    staff?.branch_id,
  ]);
  const options = useLiveQuery(() => salesFilterOptions(getDb()), []) ?? {
    staff: [],
    devices: [],
  };

  // A new filter starts again at the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the query changes
  useEffect(
    () => setShown(PAGE),
    [preset, custom.from, custom.to, query, method, status, staffId, deviceId],
  );

  const visibleDays = useMemo(() => {
    if (!data) return [];
    let left = shown;
    const out: SalesDay[] = [];
    for (const day of data.days) {
      if (left <= 0) break;
      const rows = day.rows.slice(0, left);
      left -= rows.length;
      out.push({ ...day, rows });
    }
    return out;
  }, [data, shown]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !data) return;
    if (shown >= data.rows.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting))
          setShown((count) => count + PAGE);
      },
      { rootMargin: '240px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [data, shown]);

  const runPreset = (next: SalesPreset) => {
    setPreset(next);
    if (next !== 'custom') setCustom({ from: today, to: today });
  };

  return (
    <Box
      p={embedded ? undefined : 'md'}
      mx={embedded ? undefined : 'auto'}
      maw={embedded ? undefined : 1152}
      w="100%"
    >
      <Stack gap="sm">
        <PageHeader
          icon={<SalesIcon />}
          tone="bg-info-subtle text-info-subtle-ink"
          title={t('nav.sales')}
          subtitle={t('office.sales.subtitle')}
          headingLevel={detailOpen ? 'h2' : 'h1'}
          actions={
            can('export.data') ? (
              <Button
                type="button"
                variant="default"
                disabled={!data || data.rows.length === 0}
                onClick={() =>
                  data &&
                  downloadText(
                    'bikri-sales.csv',
                    salesCsv(data.rows, data.timeZone),
                  )
                }
              >
                {t('office.sales.export_csv')}
              </Button>
            ) : undefined
          }
        />

        {limited ? (
          <Paper p="xs">
            <Text size="sm" c="dimmed">
              {t('office.sales.cashier_limited')}
            </Text>
          </Paper>
        ) : (
          <Paper withBorder p="sm">
            <Group gap="xs">
              {PRESETS.map((p) => (
                <Button
                  key={p.id}
                  type="button"
                  size="compact-sm"
                  variant={preset === p.id ? 'light' : 'default'}
                  aria-pressed={preset === p.id}
                  onClick={() => runPreset(p.id)}
                >
                  {t(p.key)}
                </Button>
              ))}
              {preset === 'custom' ? (
                <Group gap="xs" align="flex-end">
                  <TextInput
                    type="date"
                    label={t('office.sales.from')}
                    value={custom.from}
                    max={custom.to}
                    onChange={(event) =>
                      setCustom((c) => ({
                        ...c,
                        from: event.currentTarget.value,
                      }))
                    }
                  />
                  <TextInput
                    type="date"
                    label={t('office.sales.to')}
                    value={custom.to}
                    min={custom.from}
                    onChange={(event) =>
                      setCustom((c) => ({
                        ...c,
                        to: event.currentTarget.value,
                      }))
                    }
                  />
                </Group>
              ) : null}
            </Group>
          </Paper>
        )}

        <Box component="search">
          <Paper withBorder p="sm">
            <Group align="flex-end" gap="sm">
              <TextInput
                type="search"
                label={t('office.sales.search')}
                placeholder={t('office.sales.search_placeholder')}
                leftSection={<SearchIcon />}
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                style={{ flex: '3 1 16rem', minWidth: 0 }}
              />
              <Button
                type="button"
                variant="default"
                hiddenFrom="lg"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                {t('common.filters')}
                {activeFilters > 0 ? (
                  <Box
                    component="span"
                    ms={6}
                    px={6}
                    style={{
                      borderRadius: 999,
                      background: 'var(--mantine-color-brand-6)',
                      color: 'var(--mantine-color-white)',
                    }}
                  >
                    {activeFilters}
                  </Box>
                ) : null}
              </Button>
            </Group>
            <Group
              align="flex-end"
              gap="sm"
              mt="sm"
              display={filtersOpen ? undefined : { base: 'none', lg: 'flex' }}
            >
              <NativeSelect
                label={t('office.sales.filter_method')}
                value={method}
                onChange={(event) =>
                  setMethod(event.currentTarget.value as MethodFilter | '')
                }
                data={[
                  { value: '', label: t('office.sales.all_methods') },
                  ...METHOD_FILTERS.map((m) => ({
                    value: m,
                    label:
                      m === 'split'
                        ? t('office.sales.method_split')
                        : methodLabel(t, m),
                  })),
                ]}
                style={{ flex: '1 1 9rem', minWidth: 0 }}
              />
              <NativeSelect
                label={t('office.sales.filter_status')}
                value={status}
                onChange={(event) =>
                  setStatus(event.currentTarget.value as SaleStatus | '')
                }
                data={[
                  { value: '', label: t('office.sales.all_statuses') },
                  ...STATUSES.map((s) => ({
                    value: s,
                    label: statusLabel(t, s),
                  })),
                ]}
                style={{ flex: '1 1 9rem', minWidth: 0 }}
              />
              <NativeSelect
                label={t('office.sales.filter_cashier')}
                value={staffId}
                onChange={(event) => setStaffId(event.currentTarget.value)}
                data={[
                  { value: '', label: t('office.sales.all_cashiers') },
                  ...options.staff.map((s) => ({
                    value: s.id,
                    label: s.name,
                  })),
                ]}
                style={{ flex: '1 1 9rem', minWidth: 0 }}
              />
              <NativeSelect
                label={t('office.sales.filter_device')}
                value={deviceId}
                onChange={(event) => setDeviceId(event.currentTarget.value)}
                data={[
                  { value: '', label: t('office.sales.all_devices') },
                  ...options.devices.map((d) => ({
                    value: d.id,
                    label: d.name,
                  })),
                ]}
                style={{ flex: '1 1 9rem', minWidth: 0 }}
              />
            </Group>
          </Paper>
        </Box>

        {data && data.rows.length > 0 ? (
          <Paper withBorder p="sm" data-testid="sales-summary">
            <SimpleGrid cols={embedded ? 2 : { base: 2, sm: 4 }} spacing="sm">
              <Metric
                label={t('office.sales.summary_bills')}
                value={String(data.summary.bills)}
              />
              <Metric
                label={t('office.sales.summary_sold')}
                value={<MoneyText paisa={data.summary.sold} />}
              />
              <Metric
                label={t('office.sales.summary_refunds')}
                value={<MoneyText paisa={data.summary.refunds} />}
              />
              <Metric
                label={t('office.sales.summary_avg')}
                value={<MoneyText paisa={data.summary.avgBill} />}
              />
            </SimpleGrid>
          </Paper>
        ) : null}

        {data && data.rows.length === 0 ? (
          <EmptyState
            icon={<SalesIcon />}
            message={
              query || method || status || staffId || deviceId
                ? t('office.sales.no_match')
                : t('office.sales.empty')
            }
          />
        ) : null}

        {visibleDays.map((day) => (
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
                  {dayHeading(
                    t,
                    day.date,
                    today,
                    yesterday,
                    i18n.language,
                    data?.timeZone ?? 'Asia/Karachi',
                  )}
                </Title>
                <Text size="sm" c="dimmed">
                  {t('office.sales.day_total', {
                    bills: day.bills,
                    amount: formatShopMoney(day.total),
                  })}
                </Text>
              </Group>
              <Paper withBorder p={0} style={{ overflow: 'hidden' }}>
                <Box
                  component="ul"
                  style={{ listStyle: 'none', margin: 0, padding: 0 }}
                >
                  <Box
                    component="li"
                    className={`${SALE_GRID} hidden sm:grid`}
                    aria-hidden="true"
                    px="sm"
                    py="xs"
                    style={{
                      borderBottom:
                        '1px solid var(--mantine-color-default-border)',
                      background: 'var(--mantine-color-default-hover)',
                      fontSize: 'var(--mantine-font-size-sm)',
                      color: 'var(--mantine-color-dimmed)',
                      paddingInlineEnd: 48,
                    }}
                  >
                    <span>{t('office.sales.col_time')}</span>
                    <span>{t('office.sales.col_invoice')}</span>
                    <span>{t('office.sales.col_customer')}</span>
                    <span className="text-end">
                      {t('office.sales.col_items')}
                    </span>
                    <span className="text-end">
                      {t('office.sales.col_total')}
                    </span>
                    <span>{t('office.sales.col_method')}</span>
                    <span className="text-end">
                      {t('office.sales.col_status')}
                    </span>
                  </Box>
                  {day.rows.map((row) => (
                    <SaleRow
                      key={row.sale.id}
                      row={row}
                      current={row.sale.id === selectedId}
                      timeZone={data?.timeZone ?? 'Asia/Karachi'}
                      onReprint={async () => {
                        await queueSalePrint(getDb(), String(row.sale.id), {
                          reprint: true,
                        });
                        toast.push(t('office.bill.print_queued'));
                      }}
                    />
                  ))}
                </Box>
              </Paper>
            </Stack>
          </Box>
        ))}

        {data &&
        data.rows.length >
          visibleDays.reduce((s, d) => s + d.rows.length, 0) ? (
          <Text
            ref={sentinel}
            py="md"
            ta="center"
            size="sm"
            c="dimmed"
            component="div"
          >
            {t('office.sales.loading_more')}
          </Text>
        ) : null}
      </Stack>
    </Box>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fz={24} fw={600}>
        {value}
      </Text>
    </Box>
  );
}

function SaleRow({
  row,
  current,
  timeZone,
  onReprint,
}: {
  row: SaleListRow;
  current: boolean;
  timeZone: string;
  onReprint: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const sale = row.sale;
  const status = String(sale.status);
  return (
    <li className="relative border-b border-border">
      <Link
        to="/sales/$id"
        params={{ id: sale.id }}
        resetScroll={false}
        onClick={rememberListScroll}
        aria-current={current ? 'page' : undefined}
        className={`${SALE_GRID} px-2 py-2 pe-12 hover:bg-surface-2 ${current ? 'bg-primary-subtle' : ''}`}
      >
        <span className="font-mono text-small text-text-muted">
          {timeText(Number(sale.created_at), i18n.language, timeZone)}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-mono font-medium">
            {String(sale.invoice_no)}
          </span>
          <span className="block truncate text-small text-text-muted sm:hidden">
            {row.customerName ?? t('office.sales.walk_in')}
          </span>
        </span>
        <span className="hidden min-w-0 truncate text-text-muted sm:block">
          {row.customerName ?? t('office.sales.walk_in')}
        </span>
        <span className="hidden text-end text-small text-text-muted sm:block">
          {qtyText(Number(sale.items_qty_milli))}
        </span>
        <span className="text-end">
          <MoneyText paisa={Number(sale.total)} />
        </span>
        <span className="col-span-2 flex flex-wrap gap-1 sm:col-span-1">
          {row.methods.map((m) => (
            <span
              key={m}
              className="rounded-full border border-border px-2 text-small text-text-muted"
            >
              {methodLabel(t, m)}
            </span>
          ))}
        </span>
        <span className="justify-self-start sm:justify-self-end">
          <StatusPill
            label={statusLabel(t, status)}
            tone={
              status === 'paid'
                ? 'success'
                : status === 'part_refunded'
                  ? 'warning'
                  : status === 'void'
                    ? 'danger'
                    : 'gray'
            }
          />
        </span>
      </Link>
      {row.printFailed ? (
        <button
          type="button"
          className="absolute end-1 top-1/2 -translate-y-1/2 rounded-control p-2 text-danger"
          title={t('office.sales.print_failed')}
          aria-label={t('office.sales.print_failed')}
          onClick={() => void onReprint()}
        >
          <span aria-hidden="true">⎙</span>
        </button>
      ) : null}
    </li>
  );
}
