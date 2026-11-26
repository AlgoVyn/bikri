import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import { DateField } from '../components/DateField.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { QuoteIcon, SearchIcon } from '../components/icons.tsx';
import { ListSurface } from '../components/ListSurface.tsx';
import { Metric } from '../components/Metric.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { PageLoading } from '../components/PageLoading.tsx';
import { SalesTabs } from '../components/SalesTabs.tsx';
import { ScrollStrip } from '../components/ScrollStrip.tsx';
import { SortDirectionButton, SortHeader } from '../components/SortHeader.tsx';
import { searchInputClass, searchWrapperClass } from '../components/search.ts';
import { useToast } from '../components/Toast.tsx';
import { addDays } from '../data/backdate.ts';
import { CART_IDS, isEmptyCart } from '../data/cart.ts';
import { getDb } from '../data/db.ts';
import {
  type QuoteDisplayStatus,
  quoteStatus,
  quotesCsv,
  startNewQuote,
} from '../data/quotes.ts';
import { rangeFor } from '../data/salesHistory.ts';
import { useBusinessDates } from '../data/useBusinessDates.ts';
import {
  useShopTimeZone,
  useShopTimeZoneReady,
} from '../data/useShopTimeZone.ts';
import { formatBusinessDate } from '../lib/date.ts';
import { readDateFilter, rememberDateFilter } from '../lib/dateFilter.ts';
import { downloadText } from '../lib/download.ts';
import { rememberListScroll } from '../lib/listScroll.ts';
import { useSellStore } from '../sell/sellStore.ts';
import { interactiveTarget, plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { quoteVisible, seesAllDates } from '../state/reportScope.ts';

const PRESETS = [
  { id: 'today', key: 'office.sales.range_today' },
  { id: 'yesterday', key: 'office.sales.range_yesterday' },
  { id: '7d', key: 'office.sales.range_7d' },
  { id: '30d', key: 'office.sales.range_30d' },
  { id: 'month', key: 'office.sales.range_month' },
  { id: 'custom', key: 'office.sales.range_custom' },
] as const;

const STATUS_FILTERS: Array<'' | QuoteDisplayStatus> = [
  '',
  'open',
  'converted',
  'expired',
  'cancelled',
];

const SORT_OPTIONS = ['date', 'total', 'validity'] as const;
type QuoteSort = (typeof SORT_OPTIONS)[number];

const PRESET_IDS = PRESETS.map((option) => option.id);

const selectClass =
  'h-11 min-w-0 rounded-control border border-border-strong bg-surface px-2 text-text';

/** Same three-column phone / six-column desktop shape as the Bills list. */
const QUOTE_GRID_FULL =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-2 py-2 pe-3 lg:grid-cols-[7.5rem_minmax(0,1.2fr)_minmax(0,1.1fr)_3.5rem_6rem_7rem]';
const QUOTE_GRID_EMBEDDED =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-2 py-2 pe-3 lg:grid-cols-[7.5rem_minmax(0,1.4fr)_6rem_6.5rem]';

type QuoteRow = {
  id: string;
  quote_no: string;
  business_date: string;
  valid_until: string;
  customer_name: string;
  customer_phone: string;
  items_qty_milli: number;
  total: number;
  status: string;
  staff_id: string;
  device_id: string;
  branch_id: string;
  converted_at: number | null;
  cancelled_at: number | null;
};

function statusTone(display: QuoteDisplayStatus): string {
  if (display === 'open') return 'bg-primary-subtle text-primary-subtle-ink';
  if (display === 'converted')
    return 'bg-success-subtle text-success-subtle-ink';
  if (display === 'expired') return 'bg-warning-subtle text-warning-subtle-ink';
  return 'bg-danger-subtle text-danger-subtle-ink';
}

export function QuotesList(props: {
  embedded?: boolean;
  detailOpen?: boolean;
  selectedId?: string;
}) {
  const ready = useShopTimeZoneReady();
  return ready ? <QuotesListContent {...props} /> : <PageLoading compact />;
}

function QuotesListContent({
  embedded = false,
  detailOpen = false,
  selectedId: routeSelectedId,
}: {
  embedded?: boolean;
  detailOpen?: boolean;
  selectedId?: string;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { can, role, support, branchId } = useCurrentStaff();
  const readOnly = useReadOnly();
  const canQuote = can('sale.create');
  const setActive = useSellStore((s) => s.setActive);
  const timeZone = useShopTimeZone();
  const { today } = useBusinessDates(timeZone);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'' | QuoteDisplayStatus>('');
  const [sort, setSort] = useState<QuoteSort>('date');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [stored] = useState(() =>
    readDateFilter('sales', PRESET_IDS, 'today', today),
  );
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>(
    stored.preset,
  );
  const [custom, setCustom] = useState({
    from: stored.from,
    to: stored.to,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const selectedId = routeSelectedId ?? selected;
  const limited = !seesAllDates(role, support, can('report.view'));
  const activeFilters =
    (status ? 1 : 0) + (sort === 'date' && direction === 'desc' ? 0 : 1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `today` changes at midnight and must rebuild the range
  const range = useMemo(
    () => rangeFor(preset, Date.now(), timeZone, custom),
    [preset, custom, timeZone, today],
  );
  const rangeError = preset === 'custom' && custom.from > custom.to;
  useEffect(() => {
    if (!limited) rememberDateFilter('sales', preset, custom.from, custom.to);
  }, [preset, custom.from, custom.to, limited]);
  const runPreset = (next: (typeof PRESETS)[number]['id']) => {
    setPreset(next);
    if (next !== 'custom') setCustom({ from: today, to: today });
  };

  const data = useLiveQuery(async () => {
    const empty = {
      quotes: [] as QuoteRow[],
      names: new Map<string, string[]>(),
      staff: new Map<string, string>(),
      devices: new Map<string, string>(),
      billCount: 0,
    };
    if (rangeError) return empty;
    const db = getDb();
    let quotes: QuoteRow[];
    if (limited) {
      // A cashier can convert an open quote from any date, and sees converted or
      // cancelled history from today only. The terminal ranges are filtered in memory
      // by `quoteVisible` because `converted_at`/`cancelled_at` are timestamps; the
      // ±2-day window covers every shop time zone around the business date.
      const todayRange = rangeFor('today', Date.now(), timeZone);
      const dayMs = 86_400_000;
      const from = Date.parse(`${todayRange.from}T00:00:00Z`) - 2 * dayMs;
      const to = Date.parse(`${todayRange.to}T00:00:00Z`) + 2 * dayMs;
      const open = (await db.quotations
        .where('[status+valid_until]')
        .between(['open', ''], ['open', '\uffff'], true, true)
        .toArray()) as unknown as QuoteRow[];
      const converted = (await db.quotations
        .where('[status+converted_at]')
        .between(['converted', from], ['converted', to], true, true)
        .toArray()) as unknown as QuoteRow[];
      const cancelled = (await db.quotations
        .where('[status+cancelled_at]')
        .between(['cancelled', from], ['cancelled', to], true, true)
        .toArray()) as unknown as QuoteRow[];
      const seen = new Set<string>();
      quotes = [];
      for (const quote of [...open, ...converted, ...cancelled]) {
        if (seen.has(quote.id)) continue;
        seen.add(quote.id);
        quotes.push(quote);
      }
    } else {
      quotes = (await db.quotations
        .where('business_date')
        .between(range.from, range.to, true, true)
        .toArray()) as unknown as QuoteRow[];
    }
    const billCount = limited
      ? await db.sales
          .where('business_date')
          .equals(today)
          .filter(
            (sale) => branchId === null || String(sale.branch_id) === branchId,
          )
          .count()
      : await db.sales
          .where('business_date')
          .between(range.from, range.to, true, true)
          .count();
    quotes = quotes.filter((quote) =>
      quoteVisible({
        role,
        support,
        canViewReports: can('report.view'),
        canQuote,
        status: String(quote.status),
        businessDate: String(quote.business_date),
        branchId,
        quoteBranchId: String(quote.branch_id ?? ''),
        today,
        timeZone,
        convertedAt: Number(quote.converted_at ?? 0) || null,
        cancelledAt: Number(quote.cancelled_at ?? 0) || null,
      }),
    );
    const ids = quotes.map((quote) => quote.id);
    const names = new Map<string, string[]>();
    if (ids.length > 0) {
      const lines = await db.quotation_lines
        .where('quote_id')
        .anyOf(ids)
        .toArray();
      for (const line of lines) {
        if (line.deleted_at !== null && line.deleted_at !== undefined) continue;
        const quoteId = String(line.quote_id);
        names.set(quoteId, [
          ...(names.get(quoteId) ?? []),
          String(line.name_snapshot ?? ''),
          ...(typeof line.bundle_name === 'string' && line.bundle_name !== ''
            ? [line.bundle_name]
            : []),
        ]);
      }
    }
    const staff = new Map(
      (await db.staff.toArray()).map((row) => [row.id, String(row.name)]),
    );
    const devices = new Map(
      (await db.devices.toArray()).map((row) => [
        row.id,
        String(row.name ?? row.device_code ?? ''),
      ]),
    );
    return { quotes, names, staff, devices, billCount };
  }, [
    range.from,
    range.to,
    today,
    limited,
    role,
    support,
    branchId,
    canQuote,
    timeZone,
    rangeError,
  ]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = deferredQuery.trim().toLowerCase();
    const filtered = data.quotes.filter((quote) => {
      const display = quoteStatus(quote, today);
      if (status && display !== status) return false;
      if (!needle) return true;
      return [
        quote.quote_no,
        quote.customer_name,
        quote.customer_phone,
        ...(data.names.get(quote.id) ?? []),
      ].some((value) => String(value).toLowerCase().includes(needle));
    });
    return filtered.sort((a, b) => {
      const dir = direction === 'asc' ? 1 : -1;
      if (sort === 'total') return (a.total - b.total) * dir;
      if (sort === 'validity')
        return String(a.valid_until).localeCompare(String(b.valid_until)) * dir;
      return (
        (String(a.business_date).localeCompare(String(b.business_date)) ||
          a.quote_no.localeCompare(b.quote_no)) * dir
      );
    });
  }, [data, deferredQuery, status, sort, direction, today]);

  const summary = useMemo(() => {
    if (!data)
      return {
        open: 0,
        openValue: 0,
        expiring: 0,
        converted: 0,
        convertedValue: 0,
      };
    return data.quotes.reduce(
      (out, quote) => {
        const display = quoteStatus(quote, today);
        if (display === 'open') {
          out.open += 1;
          out.openValue += quote.total;
          if (quote.valid_until <= addDays(today, 7)) out.expiring += 1;
        }
        if (display === 'converted') {
          out.converted += 1;
          out.convertedValue += quote.total;
        }
        return out;
      },
      { open: 0, openValue: 0, expiring: 0, converted: 0, convertedValue: 0 },
    );
  }, [data, today]);

  const clearFilters = () => {
    setQuery('');
    setStatus('');
    setSort('date');
    setDirection('desc');
  };

  useHotkey(
    (event) =>
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'n',
    () => void newQuote(),
    { enabled: !readOnly && canQuote },
  );
  useHotkey(
    (event) =>
      event.key === 'F2' ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f'),
    () => searchRef.current?.focus(),
    { inFields: true },
  );
  const moveSelection = (delta: number) => {
    if (rows.length === 0) return;
    const index = rows.findIndex((row) => row.id === selectedId);
    const next = Math.max(
      0,
      Math.min(rows.length - 1, index === -1 ? 0 : index + delta),
    );
    setSelected(rows[next]?.id ?? null);
  };
  useHotkey(plainKey('arrowdown'), () => moveSelection(1));
  useHotkey(plainKey('arrowup'), () => moveSelection(-1));
  useHotkey(
    (event) =>
      event.key === 'Enter' &&
      selectedId !== null &&
      !interactiveTarget(event.target),
    () => {
      if (selectedId)
        void navigate({
          to: '/quotations/$id',
          params: { id: selectedId },
        });
    },
  );

  const exportCsv = () => {
    if (!data) return;
    downloadText(
      'bikri-quotations.csv',
      quotesCsv(rows, data.staff, data.devices, today),
    );
  };

  const newQuote = async () => {
    if (readOnly) {
      toast.push(t('tenant.readOnly.blocked'), 'error');
      return;
    }
    if (!canQuote) {
      toast.push(t('office.quotations.forbidden'), 'error');
      return;
    }
    try {
      const db = getDb();
      const carts = await db.carts.bulkGet([...CART_IDS]);
      const free = CART_IDS.find((_id, index) => {
        const cart = carts[index];
        return !cart || isEmptyCart(cart);
      });
      if (!free) {
        toast.push(t('office.quotations.no_free_cart'), 'error');
        return;
      }
      await startNewQuote(db, free);
      setActive(free);
      void navigate({ to: '/sell' });
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };

  if (!data) return <PageLoading compact />;

  return (
    <div
      className={
        embedded ? 'flex min-w-0 flex-col gap-3' : pageClass('standard')
      }
    >
      <PageHeader
        icon={<QuoteIcon />}
        title={t('office.quotations.title')}
        subtitle={t('office.quotations.subtitle')}
        headingLevel={detailOpen ? 'h2' : 'h1'}
        hideTitleOnPhone
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!readOnly && canQuote ? (
              <button
                type="button"
                className={buttonPrimary}
                data-testid="new-quote"
                onClick={() => void newQuote()}
              >
                {t('office.quotations.new')}
              </button>
            ) : null}
            {can('export.data') ? (
              <button
                type="button"
                className={buttonQuiet}
                data-testid="export-quotes"
                disabled={rows.length === 0}
                onClick={exportCsv}
              >
                {t('office.quotations.export_csv')}
              </button>
            ) : null}
          </div>
        }
      />

      <SalesTabs
        active="quotations"
        billCount={data.billCount}
        quotationCount={data.quotes.length}
      />

      {rangeError ? (
        <p role="alert" className="text-small text-danger">
          {t('office.sales.range_invalid')}
        </p>
      ) : null}

      {limited ? (
        <p className="rounded-control bg-surface-2 px-3 py-2 text-small text-text-muted">
          {t('office.quotations.cashier_limited')}
        </p>
      ) : (
        <ScrollStrip className="items-center">
          {PRESETS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={preset === option.id}
              className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
              onClick={() => runPreset(option.id)}
            >
              {t(option.key)}
            </button>
          ))}
        </ScrollStrip>
      )}
      {!limited && preset === 'custom' ? (
        <div className="flex flex-wrap items-end gap-2">
          <DateField
            className="w-[9.5rem]"
            label={t('office.sales.from')}
            value={custom.from}
            max={custom.to}
            onChange={(value) =>
              setCustom((current) => ({ ...current, from: value }))
            }
          />
          <DateField
            className="w-[9.5rem]"
            label={t('office.sales.to')}
            value={custom.to}
            min={custom.from}
            max={today}
            onChange={(value) =>
              setCustom((current) => ({ ...current, to: value }))
            }
          />
        </div>
      ) : null}

      <ListSurface
        toolbar={
          <search className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-[2_1_14rem] flex-col">
              <span className="mb-1 text-small">
                {t('office.quotations.search')}
              </span>
              <span className={searchWrapperClass}>
                <SearchIcon />
                <input
                  ref={searchRef}
                  type="search"
                  autoComplete="off"
                  className={searchInputClass}
                  value={query}
                  placeholder={t('office.quotations.search_placeholder')}
                  onChange={(event) => setQuery(event.target.value)}
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
              <label className="flex min-w-0 flex-[0_1_8rem] flex-col">
                <span className="mb-1 text-small">
                  {t('office.quotations.status')}
                </span>
                <select
                  className={selectClass}
                  value={status}
                  onChange={(event) =>
                    setStatus(event.target.value as '' | QuoteDisplayStatus)
                  }
                >
                  {STATUS_FILTERS.map((value) => (
                    <option key={value || 'all'} value={value}>
                      {t(
                        value
                          ? `office.quotations.status_${value}`
                          : 'office.quotations.all_statuses',
                      )}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex min-w-0 flex-[0_1_10rem] flex-col">
                <span className="mb-1 text-small">
                  {t('office.sales.sort')}
                </span>
                <div className="flex gap-1">
                  <select
                    aria-label={t('office.sales.sort')}
                    className={`${selectClass} min-w-0 flex-1`}
                    value={sort}
                    onChange={(event) => {
                      const next = event.target.value as QuoteSort;
                      setSort(next);
                      setDirection(next === 'validity' ? 'asc' : 'desc');
                    }}
                  >
                    <option value="date">
                      {t('office.quotations.col_quote')}
                    </option>
                    <option value="total">
                      {t('office.quotations.col_total')}
                    </option>
                    <option value="validity">
                      {t('office.quotations.col_validity')}
                    </option>
                  </select>
                  <SortDirectionButton
                    direction={direction}
                    onToggle={() =>
                      setDirection((value) =>
                        value === 'asc' ? 'desc' : 'asc',
                      )
                    }
                    testId="quotes-sort-direction"
                  />
                </div>
              </div>
            </div>
          </search>
        }
      >
        {data.quotes.length > 0 ? (
          <div
            data-testid="quotes-summary"
            className={`grid gap-3 border-b border-border px-3 py-3 ${
              embedded ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'
            }`}
          >
            <Metric
              label={t('office.quotations.open_quotes')}
              value={summary.open}
            />
            <Metric
              label={t('office.quotations.open_value')}
              value={<MoneyText paisa={summary.openValue} />}
            />
            <Metric
              label={t('office.quotations.converted')}
              value={summary.converted}
              hint={
                <p className="text-small text-text-muted">
                  <MoneyText paisa={summary.convertedValue} />
                </p>
              }
            />
            <Metric
              label={t('office.quotations.expiring_soon')}
              value={summary.expiring}
              valueClassName={summary.expiring > 0 ? 'text-warning' : ''}
            />
          </div>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            icon={<QuoteIcon />}
            message={
              data.quotes.length === 0
                ? t('office.quotations.empty')
                : t('office.quotations.no_match')
            }
            variant="plain"
            actionLabel={
              data.quotes.length === 0 && !readOnly && canQuote
                ? t('office.quotations.new')
                : data.quotes.length > 0
                  ? t('common.clear_filters')
                  : undefined
            }
            onAction={
              data.quotes.length === 0 && !readOnly && canQuote
                ? () => void newQuote()
                : data.quotes.length > 0
                  ? clearFilters
                  : undefined
            }
          />
        ) : (
          <ul aria-label={t('office.quotations.list_label')}>
            <li
              data-testid="quotes-list-header"
              className={`${embedded ? QUOTE_GRID_EMBEDDED : QUOTE_GRID_FULL} hidden border-b border-border bg-surface-2 py-2 text-small text-text-muted lg:grid`}
            >
              <SortHeader
                label={t('office.quotations.col_quote')}
                active={sort === 'date'}
                direction={direction}
                onClick={() => {
                  if (sort === 'date')
                    setDirection((value) => (value === 'asc' ? 'desc' : 'asc'));
                  else {
                    setSort('date');
                    setDirection('desc');
                  }
                }}
              />
              <span>{t('office.sales.col_customer')}</span>
              {embedded ? null : (
                <>
                  <SortHeader
                    label={t('office.quotations.col_validity')}
                    active={sort === 'validity'}
                    direction={direction}
                    onClick={() => {
                      if (sort === 'validity')
                        setDirection((value) =>
                          value === 'asc' ? 'desc' : 'asc',
                        );
                      else {
                        setSort('validity');
                        setDirection('asc');
                      }
                    }}
                  />
                  <span>{t('office.sales.col_items')}</span>
                </>
              )}
              <SortHeader
                label={t('office.quotations.col_total')}
                active={sort === 'total'}
                direction={direction}
                onClick={() => {
                  if (sort === 'total')
                    setDirection((value) => (value === 'asc' ? 'desc' : 'asc'));
                  else {
                    setSort('total');
                    setDirection('desc');
                  }
                }}
              />
              <span>{t('office.quotations.status')}</span>
            </li>
            {rows.map((quote) => {
              const display = quoteStatus(quote, today);
              const current = selectedId === quote.id;
              return (
                <li
                  key={quote.id}
                  className="relative border-b border-border last:border-b-0"
                >
                  <Link
                    to="/quotations/$id"
                    params={{ id: quote.id }}
                    resetScroll={false}
                    data-testid="quote-row"
                    aria-current={current ? 'page' : undefined}
                    onClick={rememberListScroll}
                    onFocus={() => setSelected(quote.id)}
                    className={`${embedded ? QUOTE_GRID_EMBEDDED : QUOTE_GRID_FULL} min-h-11 transition-colors duration-150 hover:bg-surface-2 ${
                      current
                        ? 'border-s-2 border-s-primary bg-primary-subtle'
                        : 'border-s-2 border-s-transparent'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-small font-semibold">
                          {quote.quote_no}
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-1.5 text-caption font-medium lg:hidden ${statusTone(display)}`}
                        >
                          {t(`office.quotations.status_${display}`)}
                        </span>
                      </span>
                      <span className="block truncate text-small text-text-muted lg:hidden">
                        {quote.customer_name || t('sell.walk_in')}
                      </span>
                    </span>
                    <span className="hidden min-w-0 lg:block">
                      <span className="block truncate">
                        {quote.customer_name || t('sell.walk_in')}
                      </span>
                      {quote.customer_phone ? (
                        <span className="block truncate text-small text-text-muted">
                          {quote.customer_phone}
                        </span>
                      ) : null}
                    </span>
                    {embedded ? null : (
                      <>
                        <span className="hidden whitespace-nowrap text-small text-text-muted lg:block">
                          <bdi dir="ltr">
                            {formatBusinessDate(
                              quote.valid_until,
                              i18n.language,
                            )}
                          </bdi>
                        </span>
                        <span className="hidden text-small text-text-muted lg:block">
                          {t('office.quotations.items', {
                            count: quote.items_qty_milli / 1000,
                          })}
                        </span>
                      </>
                    )}
                    <span className="text-start font-medium">
                      <MoneyText paisa={quote.total} />
                    </span>
                    <span
                      className={`hidden whitespace-nowrap justify-self-start rounded-full px-2 text-small font-medium lg:block ${statusTone(display)}`}
                    >
                      {t(`office.quotations.status_${display}`)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </ListSurface>
    </div>
  );
}
