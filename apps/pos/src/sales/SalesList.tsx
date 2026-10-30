import { businessDate } from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { SalesIcon, SearchIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
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
import { formatShopMoney } from '../lib/money';
import { useCurrentStaff } from '../state/currentStaff.ts';
import {
  dayHeading,
  methodLabel,
  qtyText,
  statusLabel,
  statusTone,
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

const selectClass =
  'h-11 min-w-0 rounded-control border border-border-strong bg-surface px-2 text-text';

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
    <div
      className={
        embedded
          ? 'flex min-w-0 flex-col gap-3'
          : 'mx-auto flex max-w-6xl flex-col gap-3 p-4'
      }
    >
      <PageHeader
        icon={<SalesIcon />}
        tone="bg-info-subtle text-info-subtle-ink"
        title={t('nav.sales')}
        subtitle={t('office.sales.subtitle')}
        headingLevel={detailOpen ? 'h2' : 'h1'}
        actions={
          can('export.data') ? (
            <button
              type="button"
              className={buttonQuiet}
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
            </button>
          ) : undefined
        }
      />

      {limited ? (
        <p className="rounded-control bg-surface-2 px-3 py-2 text-small text-text-muted">
          {t('office.sales.cashier_limited')}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1 rounded-card border border-border bg-surface p-3 shadow-card">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={preset === p.id}
              className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
              onClick={() => runPreset(p.id)}
            >
              {t(p.key)}
            </button>
          ))}
          {preset === 'custom' ? (
            <span className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col text-small">
                {t('office.sales.from')}
                <input
                  type="date"
                  className={selectClass}
                  value={custom.from}
                  max={custom.to}
                  onChange={(e) =>
                    setCustom((c) => ({ ...c, from: e.target.value }))
                  }
                />
              </label>
              <label className="flex flex-col text-small">
                {t('office.sales.to')}
                <input
                  type="date"
                  className={selectClass}
                  value={custom.to}
                  min={custom.from}
                  onChange={(e) =>
                    setCustom((c) => ({ ...c, to: e.target.value }))
                  }
                />
              </label>
            </span>
          ) : null}
        </div>
      )}

      <search className="flex flex-wrap items-end gap-2 rounded-card border border-border bg-surface p-3 shadow-card">
        <label className="flex min-w-0 flex-[3_1_16rem] flex-col">
          <span className="mb-1 text-small">{t('office.sales.search')}</span>
          <span className="flex h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-3">
            <SearchIcon />
            <input
              type="search"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-body text-text outline-none"
              placeholder={t('office.sales.search_placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
        </label>
        <button
          type="button"
          className={`${buttonQuiet} gap-2 lg:hidden`}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          {t('common.filters')}
          {activeFilters > 0 ? (
            <span className="rounded-full bg-primary px-1.5 text-small text-primary-ink">
              {activeFilters}
            </span>
          ) : null}
        </button>
        <div className={filtersOpen ? 'contents' : 'hidden lg:contents'}>
          <label className="flex min-w-0 flex-[1_1_9rem] flex-col">
            <span className="mb-1 text-small">
              {t('office.sales.filter_method')}
            </span>
            <select
              className={selectClass}
              value={method}
              onChange={(e) => setMethod(e.target.value as MethodFilter | '')}
            >
              <option value="">{t('office.sales.all_methods')}</option>
              {METHOD_FILTERS.map((m) => (
                <option key={m} value={m}>
                  {m === 'split'
                    ? t('office.sales.method_split')
                    : methodLabel(t, m)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-[1_1_9rem] flex-col">
            <span className="mb-1 text-small">
              {t('office.sales.filter_status')}
            </span>
            <select
              className={selectClass}
              value={status}
              onChange={(e) => setStatus(e.target.value as SaleStatus | '')}
            >
              <option value="">{t('office.sales.all_statuses')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(t, s)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-[1_1_9rem] flex-col">
            <span className="mb-1 text-small">
              {t('office.sales.filter_cashier')}
            </span>
            <select
              className={selectClass}
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
            >
              <option value="">{t('office.sales.all_cashiers')}</option>
              {options.staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-[1_1_9rem] flex-col">
            <span className="mb-1 text-small">
              {t('office.sales.filter_device')}
            </span>
            <select
              className={selectClass}
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              <option value="">{t('office.sales.all_devices')}</option>
              {options.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </search>

      {data && data.rows.length > 0 ? (
        <div
          data-testid="sales-summary"
          className={`grid gap-2 rounded-card border border-border bg-surface p-3 ${embedded ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`}
        >
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
        </div>
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
        <section key={day.date} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
            <h2 className="text-title font-semibold">
              {dayHeading(
                t,
                day.date,
                today,
                yesterday,
                i18n.language,
                data?.timeZone ?? 'Asia/Karachi',
              )}
            </h2>
            <p className="text-small text-text-muted">
              {t('office.sales.day_total', {
                bills: day.bills,
                amount: formatShopMoney(day.total),
              })}
            </p>
          </div>
          <ul className="flex flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
            <li
              className={`${SALE_GRID} hidden border-b border-border bg-surface-2 px-2 py-2 pe-12 text-small text-text-muted sm:grid`}
              aria-hidden="true"
            >
              <span>{t('office.sales.col_time')}</span>
              <span>{t('office.sales.col_invoice')}</span>
              <span>{t('office.sales.col_customer')}</span>
              <span className="text-end">{t('office.sales.col_items')}</span>
              <span className="text-end">{t('office.sales.col_total')}</span>
              <span>{t('office.sales.col_method')}</span>
              <span className="text-end">{t('office.sales.col_status')}</span>
            </li>
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
          </ul>
        </section>
      ))}

      {data &&
      data.rows.length > visibleDays.reduce((s, d) => s + d.rows.length, 0) ? (
        <div
          ref={sentinel}
          className="py-4 text-center text-small text-text-muted"
        >
          {t('office.sales.loading_more')}
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-small text-text-muted">{label}</p>
      <p className="text-total font-semibold">{value}</p>
    </div>
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
        <span
          className={`justify-self-start whitespace-nowrap rounded-full px-2 text-small font-medium sm:justify-self-end ${statusTone(status)}`}
        >
          {statusLabel(t, status)}
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
