import { businessDate, mulDivRound } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet, pageClass } from '../components/classes.ts';
import { DateField } from '../components/DateField.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { ReportsIcon } from '../components/icons.tsx';
import { ListPager } from '../components/ListPager.tsx';
import { Metric } from '../components/Metric.tsx';
import { MoneyText, useDisplayMoney } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { PageLoading } from '../components/PageLoading';
import { PrivacyValue } from '../components/privacy.tsx';
import { ScrollStrip } from '../components/ScrollStrip.tsx';
import { useToast } from '../components/Toast.tsx';
import { isBusinessDate } from '../data/dates.ts';
import { getDb } from '../data/db.ts';
import {
  addDays,
  type ReportBundle,
  type ReportOptions,
  type ReportSummary,
  reportBundle,
} from '../data/reportBundle.ts';
import { type ReportTab, reportCsv } from '../data/reportCsv.ts';
import {
  firstBusinessDay,
  LONG_RANGE_DAYS,
  spanDays,
} from '../data/reportRange.ts';
import type { ReportRange } from '../data/reports.ts';
import { rangeFor } from '../data/salesHistory.ts';
import { useBusinessDates } from '../data/useBusinessDates.ts';
import {
  useShopTimeZone,
  useShopTimeZoneReady,
} from '../data/useShopTimeZone.ts';
import { readDateFilter, rememberDateFilter } from '../lib/dateFilter.ts';
import { downloadText } from '../lib/download.ts';
import { downloadBlob } from '../print/receiptImage.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { DailyChart, HourlyChart, PaymentMixBar } from './charts.tsx';
import {
  bucketLabel,
  categoryName,
  daysBetween,
  groupName,
  longDate,
  percentText,
  qtyText,
} from './format.ts';
import type { ReportFileMeta } from './reportFile.ts';

type Preset =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'month'
  | 'last_month'
  | 'custom';

const PRESETS: { id: Preset; key: string }[] = [
  { id: 'today', key: 'office.reports.range_today' },
  { id: 'yesterday', key: 'office.reports.range_yesterday' },
  { id: '7d', key: 'office.reports.range_7d' },
  { id: '30d', key: 'office.reports.range_30d' },
  { id: 'month', key: 'office.reports.range_month' },
  { id: 'last_month', key: 'office.reports.range_last_month' },
  { id: 'custom', key: 'office.reports.range_custom' },
];

const REPORT_PRESET_IDS: Preset[] = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'last_month',
  'custom',
];

const TABS: { id: ReportTab; key: string }[] = [
  { id: 'summary', key: 'office.reports.tab_summary' },
  { id: 'products', key: 'office.reports.tab_products' },
  { id: 'stock', key: 'office.reports.tab_stock' },
  { id: 'udhaar', key: 'office.reports.tab_udhaar' },
  { id: 'staff', key: 'office.reports.tab_staff' },
  { id: 'day_closes', key: 'office.reports.tab_day_closes' },
  { id: 'expenses', key: 'office.reports.tab_expenses' },
];

const field =
  'h-11 min-w-0 rounded-control border border-border-strong bg-surface px-2 text-text';

/** Range chips and custom date fields, kept visible even when the range is invalid. */
function ReportRangeControls({
  limited,
  preset,
  onPreset,
  custom,
  onCustom,
  today,
  first,
  rangeLabel,
}: {
  limited: boolean;
  preset: Preset;
  onPreset: (preset: Preset) => void;
  custom: { from: string; to: string };
  onCustom: (custom: { from: string; to: string }) => void;
  today: string;
  first?: string | null;
  rangeLabel?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <ScrollStrip className="items-center">
          {(limited
            ? PRESETS.filter((item) => item.id === 'today')
            : PRESETS
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={preset === item.id}
              className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
              onClick={() => onPreset(item.id)}
            >
              {t(item.key)}
            </button>
          ))}
        </ScrollStrip>
        {rangeLabel}
      </div>
      {preset === 'custom' && !limited ? (
        <div className="flex flex-wrap items-end gap-2">
          <DateField
            className="w-[9.5rem]"
            label={t('office.reports.from')}
            value={custom.from}
            min={first ?? undefined}
            max={today}
            onChange={(value) => onCustom({ ...custom, from: value })}
          />
          <DateField
            className="w-[9.5rem]"
            label={t('office.reports.to')}
            value={custom.to}
            min={first && custom.from < first ? first : custom.from}
            max={today}
            onChange={(value) => onCustom({ ...custom, to: value })}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Reports for one range, computed on the device (screens/16). */
export function ReportsPage() {
  const ready = useShopTimeZoneReady();
  return ready ? <ReportsPageContent /> : <PageLoading compact />;
}

function ReportsPageContent() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { role, can, support } = useCurrentStaff();
  const limited = role === 'cashier' && !support;
  const cost = can('cost.view');
  const exportable = can('export.data');
  const timeZone = useShopTimeZone();
  const [stored] = useState(() =>
    readDateFilter(
      'reports',
      limited ? (['today'] as Preset[]) : REPORT_PRESET_IDS,
      'today',
      businessDate(Date.now(), timeZone),
    ),
  );
  const [preset, setPreset] = useState<Preset>(stored.preset);
  const [custom, setCustom] = useState({
    from: stored.from,
    to: stored.to,
  });
  const [deviceId, setDeviceId] = useState('');
  const [tab, setTab] = useState<ReportTab>('summary');
  const workerRef = useRef<Worker | null>(null);
  // 'starting' must not fall back to the main thread: that computed the whole bundle
  // on the counter and then again in the worker, doubling the first Reports visit.
  const [workerState, setWorkerState] = useState<
    'starting' | 'ready' | 'unavailable'
  >('starting');
  const requestId = useRef(0);
  const workerFailures = useRef(new Map<number, (error: Error) => void>());
  const firstRequest = useRef(true);
  const firstDay = useLiveQuery(() => firstBusinessDay(getDb()), []);
  // Rerun the live query when the business date passes midnight on an idle screen.
  const { today: businessToday } = useBusinessDates(timeZone);

  useEffect(() => {
    if (!limited) rememberDateFilter('reports', preset, custom.from, custom.to);
  }, [preset, custom.from, custom.to, limited]);

  // Keep the selected tab visible when the strip is scrollable (phone) or when
  // the viewport shrinks after a desktop selection. Only the strip scrolls:
  // scrollIntoView would also move the page when the keyboard/orientation
  // resizes the viewport.
  useEffect(() => {
    const scrollActive = () => {
      const active = document.getElementById(`report-tab-${tab}`);
      const strip = active?.closest<HTMLElement>('.scroll-strip');
      if (!active || !strip) return;
      const tabRect = active.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      const left = tabRect.left - stripRect.left;
      const right = tabRect.right - stripRect.right;
      if (left >= 0 && right <= 0) return;
      strip.scrollLeft += left < 0 ? left : right;
    };
    scrollActive();
    window.addEventListener('resize', scrollActive);
    return () => window.removeEventListener('resize', scrollActive);
  }, [tab]);

  useEffect(() => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./reportWorker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      // A browser without module workers falls back to the main thread below.
      setWorkerState('unavailable');
      return undefined;
    }
    const fail = (message: string) => {
      for (const reject of workerFailures.current.values())
        reject(new Error(message));
      workerFailures.current.clear();
      worker.terminate();
      workerRef.current = null;
      setWorkerState('unavailable');
    };
    const onError = (event: ErrorEvent) => {
      event.preventDefault();
      fail(event.message || 'report worker failed');
    };
    const onMessageError = () => fail('report worker message failed');
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    workerRef.current = worker;
    setWorkerState('ready');
    return () => {
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const data = useLiveQuery(async () => {
    if (workerState === 'starting') return undefined;
    const db = getDb();
    const now = Date.now();
    const today = businessDate(now, timeZone);
    const selected = limited ? 'today' : preset;
    // A cleared native date input emits ""; it must not reach addDays/Date.parse.
    if (
      selected === 'custom' &&
      (!isBusinessDate(custom.from) ||
        !isBusinessDate(custom.to) ||
        custom.from > custom.to)
    )
      return null;
    const range = reportRange(selected, now, timeZone, custom);
    const reportRangeValue: ReportRange = {
      ...range,
      deviceId: deviceId || undefined,
    };
    // Slow movers are only needed by the Products tab. The bundle (and the scan)
    // stays in the worker, and the existing 250 ms coalescing below debounces it.
    const options: ReportOptions = {
      now,
      today,
      timeZone,
      slowMovers: tab === 'products',
    };
    // daysBetween is inclusive (Today = 1); the previous window is the same span.
    const span = daysBetween(range.from, range.to);
    const previousRange: ReportRange | undefined =
      span <= 90
        ? {
            ...range,
            from: addDays(range.from, -span),
            to: addDays(range.from, -1),
            deviceId: deviceId || undefined,
          }
        : undefined;
    // Dexie liveQuery tracks these reads; the heavy aggregation itself runs in the worker.
    // One row from each table registers the dependency and is far cheaper than COUNT(*)
    // on a shop with tens of thousands of sales and movements.
    await Promise.all([
      db.sales.toCollection().first(),
      db.sale_lines.toCollection().first(),
      db.payments.toCollection().first(),
      db.refunds.toCollection().first(),
      db.sale_voids.toCollection().first(),
      db.expenses.toCollection().first(),
      db.day_closes.toCollection().first(),
      db.stock_movements.toCollection().first(),
      db.ledger_entries.toCollection().first(),
      db.products.toCollection().first(),
      db.customers.toCollection().first(),
    ]);
    // Coalesce a burst of invalidations (a pull page, a sale, a settings write) before
    // asking the worker. The worker keeps only the latest pending request, so a 200-page
    // pull can no longer queue 200 full bundles. The first open skips the wait: there is
    // no burst yet, and it is the one the user is waiting for.
    if (!firstRequest.current)
      await new Promise((resolve) => setTimeout(resolve, 250));
    firstRequest.current = false;
    const worker = workerRef.current;
    let bundle: ReportBundle;
    let previous: ReportSummary | undefined;
    const onMainThread = async (): Promise<{
      bundle: ReportBundle;
      previous: ReportSummary | undefined;
    }> => {
      const nextBundle = await reportBundle(db, reportRangeValue, options);
      const nextPrevious =
        previousRange === undefined
          ? undefined
          : (
              await reportBundle(db, previousRange, {
                ...options,
                summaryOnly: true,
              })
            ).summary;
      return { bundle: nextBundle, previous: nextPrevious };
    };
    if (worker === null || workerState === 'unavailable') {
      const computed = await onMainThread();
      bundle = computed.bundle;
      previous = computed.previous;
    } else {
      requestId.current += 1;
      const id = requestId.current;
      try {
        const result = await new Promise<{
          bundle: ReportBundle;
          previous?: ReportSummary;
        }>((resolve, reject) => {
          const onMessage = (event: MessageEvent) => {
            const payload = event.data as {
              id?: number;
              bundle?: ReportBundle;
              previous?: ReportSummary;
              error?: string;
            };
            if (payload.id !== id) return;
            worker.removeEventListener('message', onMessage);
            workerFailures.current.delete(id);
            if (payload.error !== undefined) reject(new Error(payload.error));
            else if (payload.bundle !== undefined)
              resolve({ bundle: payload.bundle, previous: payload.previous });
            else reject(new Error('empty report'));
          };
          workerFailures.current.set(id, reject);
          worker.addEventListener('message', onMessage);
          worker.postMessage({
            id,
            tenantId: db.tenantId,
            range: reportRangeValue,
            previousRange,
            options,
          });
        });
        bundle = result.bundle;
        previous = result.previous;
      } catch {
        // A worker that failed to load or crashed must not leave Reports on the
        // loading spinner; recompute this range on the main thread instead.
        const computed = await onMainThread();
        bundle = computed.bundle;
        previous = computed.previous;
      } finally {
        workerFailures.current.delete(id);
      }
    }
    const devices = (await db.devices.toArray())
      .filter((device) => !device.deleted_at)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const shop = await db.shop.get('shop');
    return {
      bundle,
      previous,
      today,
      timeZone,
      devices,
      shopName: String(shop?.name ?? ''),
      // The previous bundle can be on screen while the Products bundle is still
      // being computed; only then is the slow-movers table still loading.
      slowMoversReady: options.slowMovers === true,
    };
  }, [
    preset,
    custom.from,
    custom.to,
    deviceId,
    limited,
    workerState,
    timeZone,
    businessToday,
    tab,
  ]);

  if (!can('report.view'))
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.reports.no_permission')}
      </p>
    );

  if (data === undefined) return <PageLoading compact />;
  if (data === null)
    return (
      <div className={pageClass('standard')} data-testid="reports-page">
        <PageHeader
          icon={<ReportsIcon />}
          title={t('office.reports.title')}
          subtitle={t('office.reports.subtitle')}
          hideTitleOnPhone
        />
        <ReportRangeControls
          limited={limited}
          preset={preset}
          onPreset={setPreset}
          custom={custom}
          onCustom={setCustom}
          today={businessDate(Date.now(), timeZone)}
          first={firstDay}
        />
        <p
          role="alert"
          className="mt-2 rounded-card bg-warning-subtle p-3 text-warning-subtle-ink"
        >
          {t('office.reports.range_invalid')}
        </p>
      </div>
    );

  const bundle = data.bundle;
  const longRange =
    (preset === 'custom' ? spanDays(custom.from, custom.to) : 0) >
      LONG_RANGE_DAYS ||
    spanDays(bundle.range.from, bundle.range.to) > LONG_RANGE_DAYS;
  const lang = i18n.language;
  const meta: ReportFileMeta = {
    shopName: data.shopName,
    from: bundle.range.from,
    to: bundle.range.to,
    generatedAt: Date.now(),
    lang,
    timeZone: data.timeZone,
    showProfit: cost,
    bundle,
    labels: {
      title: t('office.reports.title'),
      range: t('office.reports.pdf_range'),
      generated: t('office.reports.pdf_generated'),
      sold: t('office.reports.sold'),
      bills: t('office.reports.bills'),
      avgBill: t('office.reports.avg_bill'),
      grossProfit: t('office.reports.gross_profit'),
      expenses: t('office.reports.expenses'),
      netProfit: t('office.reports.net_profit'),
      margin: t('office.reports.margin'),
      tax: t('office.reports.tax_collected'),
      paymentMix: t('office.reports.payment_mix'),
      chartSold: t('office.reports.chart_sold'),
      chartProfit: t('office.reports.chart_profit'),
      udhaarGiven: t('office.reports.udhaar_given'),
      udhaarReceived: t('office.reports.udhaar_received'),
      methods: {
        cash: t('payment.cash'),
        card: t('payment.card'),
        bank_wallet: t('payment.bank_wallet'),
        udhaar: t('payment.udhaar'),
      },
    },
  };
  const exportCurrent = () => {
    try {
      const csv = reportCsv(tab, bundle, {
        includeCost: cost,
        uncategorizedLabel: t('office.reports.uncategorized'),
      });
      downloadText(
        `bikri-report-${tab}-${bundle.range.from}-${bundle.range.to}.csv`,
        csv,
      );
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };
  const exportPdf = async () => {
    try {
      downloadBlob(
        await (await import('./reportFile.ts')).reportPdf(meta),
        `bikri-report-${bundle.range.from}-${bundle.range.to}.pdf`,
      );
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };
  const share = async () => {
    try {
      const { reportPng } = await import('./reportFile.ts');
      const png = await reportPng(meta);
      const file = new File(
        [png],
        `bikri-report-${bundle.range.from}-${bundle.range.to}.png`,
        { type: 'image/png' },
      );
      if (navigator.canShare?.({ files: [file] }))
        await navigator.share({
          files: [file],
          title: t('office.reports.title'),
        });
      else {
        downloadBlob(png, file.name);
        toast.push(t('done.image_saved'));
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        toast.push(t('done.share_failed'), 'error');
    }
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = TABS.findIndex((item) => item.id === tab);
    // RTL Urdu lays the strip out right-to-left, so ArrowRight moves to the
    // previous tab and ArrowLeft to the next (the reverse of LTR).
    const rtl = document.documentElement.dir === 'rtl';
    let next = current;
    if (event.key === 'ArrowDown') next = (current + 1) % TABS.length;
    else if (event.key === 'ArrowUp')
      next = (current - 1 + TABS.length) % TABS.length;
    else if (event.key === 'ArrowRight')
      next = (current + (rtl ? -1 : 1) + TABS.length) % TABS.length;
    else if (event.key === 'ArrowLeft')
      next = (current + (rtl ? 1 : -1) + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[next];
    if (target) {
      setTab(target.id);
      document.getElementById(`report-tab-${target.id}`)?.focus();
    }
  };

  return (
    <div className={pageClass('standard')} data-testid="reports-page">
      <PageHeader
        icon={<ReportsIcon />}
        title={t('office.reports.title')}
        subtitle={t('office.reports.subtitle')}
        hideTitleOnPhone
        actions={
          <>
            <label className="flex items-center gap-1 text-small">
              <span className="text-text-muted">
                {t('office.reports.device')}
              </span>
              <select
                className={field}
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
              >
                <option value="">{t('office.reports.all_devices')}</option>
                {data.devices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {String(device.name ?? device.code ?? '')}
                  </option>
                ))}
              </select>
            </label>
            {exportable ? (
              <ExportMenu
                onCsv={exportCurrent}
                onPdf={() => void exportPdf()}
                onShare={() => void share()}
              />
            ) : null}
          </>
        }
      />

      <ReportRangeControls
        limited={limited}
        preset={preset}
        onPreset={setPreset}
        custom={custom}
        onCustom={setCustom}
        today={data.today}
        first={firstDay}
        rangeLabel={
          <span
            className="text-small text-text-muted"
            data-testid="report-range"
          >
            {longDate(bundle.range.from, lang)} –{' '}
            {longDate(bundle.range.to, lang)}
          </span>
        }
      />
      {longRange ? (
        <p className="text-small text-text-muted">
          {t('office.reports.range_long')}
        </p>
      ) : null}

      <ScrollStrip
        role="tablist"
        aria-label={t('office.reports.title')}
        aria-orientation="horizontal"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`report-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={
              tab === item.id ? `report-panel-${item.id}` : undefined
            }
            tabIndex={tab === item.id ? 0 : -1}
            data-testid={`report-tab-${item.id}`}
            className="inline-flex min-h-11 items-center rounded-control px-3 aria-selected:bg-primary-subtle aria-selected:text-primary-subtle-ink"
            onClick={() => setTab(item.id)}
          >
            {t(item.key)}
          </button>
        ))}
      </ScrollStrip>

      <section
        role="tabpanel"
        id={`report-panel-${tab}`}
        aria-labelledby={`report-tab-${tab}`}
        className="flex flex-col gap-3"
      >
        {tab === 'summary' ? (
          <SummaryTab
            bundle={bundle}
            previous={data.previous}
            cost={cost}
            lang={lang}
          />
        ) : null}
        {tab === 'products' ? (
          <ProductsTab
            bundle={bundle}
            cost={cost}
            lang={lang}
            slowMoversReady={data.slowMoversReady}
          />
        ) : null}
        {tab === 'stock' ? (
          <StockTab bundle={bundle} cost={cost} lang={lang} />
        ) : null}
        {tab === 'udhaar' ? <UdhaarTab bundle={bundle} lang={lang} /> : null}
        {tab === 'staff' ? <StaffTab bundle={bundle} /> : null}
        {tab === 'day_closes' ? (
          <DayCloseTab bundle={bundle} lang={lang} />
        ) : null}
        {tab === 'expenses' ? (
          <ExpensesTab bundle={bundle} lang={lang} />
        ) : null}
      </section>
    </div>
  );
}

function reportRange(
  preset: Preset,
  now: number,
  timeZone: string,
  custom: { from: string; to: string },
): { from: string; to: string } {
  if (preset === 'last_month') {
    const today = businessDate(now, timeZone);
    const firstThisMonth = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    const end = new Date(firstThisMonth.getTime() - 86_400_000);
    const start = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1),
    );
    return {
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
    };
  }
  if (preset === 'custom') return custom;
  return rangeFor(preset, now, timeZone);
}

function Delta({
  current,
  previous,
  good = 'up',
  points = false,
}: {
  current: number;
  previous?: number;
  good?: 'up' | 'down';
  points?: boolean;
}) {
  const { t } = useTranslation();
  if (previous === undefined) return null;
  if (previous === 0) {
    return (
      <span className="text-small text-text-muted">
        {current === 0 ? '—' : t('office.reports.delta_new')}
      </span>
    );
  }
  const change = points
    ? current - previous
    : ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(change) < 0.05) {
    return <span className="text-small text-text-muted">—</span>;
  }
  const up = change > 0;
  const positive = good === 'up' ? up : !up;
  const value = points
    ? `${Math.abs(change).toFixed(1)} ${t('office.reports.pp')}`
    : `${Math.abs(Math.round(change))}%`;
  return (
    <PrivacyValue mask="••%">
      <span
        className={`text-small ${positive ? 'text-success' : 'text-danger'}`}
      >
        <bdi dir="ltr">
          {up ? '↑' : '↓'} {value}
        </bdi>{' '}
        <span className="text-text-muted">
          {t('office.reports.vs_previous')}
        </span>
      </span>
    </PrivacyValue>
  );
}

function NoRows({ message }: { message: string }) {
  return (
    <p className="rounded-card border border-border bg-surface p-4 text-center text-small text-text-muted">
      {message}
    </p>
  );
}

const REPORT_PAGE = 50;

function ReportTable({
  title,
  headers,
  rows,
  empty,
  testId,
  rowKeys,
}: {
  title: string;
  headers: readonly string[];
  rows: readonly ReactNode[][];
  empty: string;
  testId?: string;
  rowKeys?: readonly string[];
}) {
  const [page, setPage] = useState(0);
  // The rows array is rebuilt on each render; reset only when the row count changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: length is the stable signal
  useEffect(() => setPage(0), [rows.length]);
  const pageCount = Math.max(1, Math.ceil(rows.length / REPORT_PAGE));
  const pageRows = rows.slice(page * REPORT_PAGE, (page + 1) * REPORT_PAGE);
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h2 className="text-title font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <NoRows message={empty} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full min-w-[36rem] border-collapse text-small">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-start">
                {headers.map((header) => (
                  <th
                    key={header}
                    scope="col"
                    className="px-3 py-2 text-start font-medium"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, index) => (
                <tr
                  key={rowKeys?.[page * REPORT_PAGE + index] ?? String(row[0])}
                  className="border-b border-border last:border-0"
                >
                  {row.map((cell, cellIndex) => (
                    <td
                      key={headers[cellIndex]}
                      className="px-3 py-2 text-start"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ListPager page={page} pageCount={pageCount} onPage={setPage} />
    </section>
  );
}

/** A report KPI: the amount is the loudest thing in the card (review M7). */
function KpiCard({
  label,
  value,
  hint,
  testId,
  valueClassName = 'text-h2 lg:text-title xl:text-total',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  testId?: string;
  /** The figure size; a long amount steps down so it never leaves the card. */
  valueClassName?: string;
}) {
  return (
    <li
      className="min-w-0 rounded-card border border-border bg-surface p-3 shadow-card"
      data-testid={testId}
    >
      <p className="text-small text-text-muted">{label}</p>
      <p className={`mt-0.5 font-semibold tabular-nums ${valueClassName}`}>
        {value}
      </p>
      {hint ? <div className="mt-1">{hint}</div> : null}
    </li>
  );
}

function SummaryTab({
  bundle,
  previous,
  cost,
  lang,
}: {
  bundle: ReportBundle;
  previous?: ReportSummary;
  cost: boolean;
  lang: string;
}) {
  const { t } = useTranslation();
  const money = useDisplayMoney();
  const summary = bundle.summary;
  const activeHours = summary.hourly.filter((point) => point.sold !== 0);
  const singleHour = activeHours.length === 1 ? activeHours[0] : undefined;
  const singleDay = bundle.range.from === bundle.range.to;
  const activeDays = summary.daily.filter(
    (point) => point.sold !== 0 || point.grossProfit !== 0,
  ).length;
  const comparison =
    previous &&
    (previous.bills > 0 || previous.sold !== 0 || previous.expenses !== 0)
      ? previous
      : undefined;
  const hasActivity =
    summary.bills > 0 ||
    summary.refundCount > 0 ||
    summary.expenses !== 0 ||
    summary.sold !== 0 ||
    summary.udhaarGiven !== 0 ||
    summary.udhaarReceived !== 0 ||
    summary.paymentMix.card !== 0 ||
    summary.paymentMix.bank_wallet !== 0;
  // The KPI row shares one figure size. A long amount (large range, paisa) steps down
  // so it cannot leave the card; `money()` already applies grouping and privacy masking.
  const kpiTextLength = Math.max(
    money(summary.sold).length,
    money(summary.grossProfit).length,
    money(summary.avgBill).length,
    money(summary.expenses).length,
    String(summary.bills).length,
  );
  const kpiSize =
    kpiTextLength > 19
      ? 'text-small lg:text-body xl:text-h2'
      : kpiTextLength > 16
        ? 'text-body lg:text-h2 xl:text-title'
        : 'text-h2 lg:text-title xl:text-total';
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={t('office.reports.sold')}
          testId="report-sold"
          value={<MoneyText paisa={summary.sold} />}
          hint={<Delta current={summary.sold} previous={comparison?.sold} />}
          valueClassName={kpiSize}
        />
        {cost ? (
          <KpiCard
            label={t('office.reports.gross_profit')}
            testId="report-profit"
            value={<MoneyText paisa={summary.grossProfit} />}
            hint={
              <Delta
                current={summary.grossProfit}
                previous={comparison?.grossProfit}
              />
            }
            valueClassName={kpiSize}
          />
        ) : (
          <KpiCard
            label={t('office.reports.avg_bill')}
            value={<MoneyText paisa={summary.avgBill} />}
            hint={
              <Delta current={summary.avgBill} previous={comparison?.avgBill} />
            }
            valueClassName={kpiSize}
          />
        )}
        <KpiCard
          label={t('office.reports.bills')}
          testId="report-bills"
          value={summary.bills}
          hint={<Delta current={summary.bills} previous={comparison?.bills} />}
          valueClassName={kpiSize}
        />
        <KpiCard
          label={t('office.reports.expenses')}
          value={<MoneyText paisa={summary.expenses} />}
          hint={
            <Delta
              current={summary.expenses}
              previous={comparison?.expenses}
              good="down"
            />
          }
          valueClassName={kpiSize}
        />
      </ul>

      {cost || bundle.taxEnabled || summary.tax !== 0 ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
          {cost ? (
            <>
              <Metric
                label={t('office.reports.avg_bill')}
                value={<MoneyText paisa={summary.avgBill} />}
                valueClassName="max-sm:text-body"
                hint={
                  <Delta
                    current={summary.avgBill}
                    previous={comparison?.avgBill}
                  />
                }
              />
              <Metric
                label={t('office.reports.net_profit')}
                value={<MoneyText paisa={summary.netProfit} />}
                valueClassName="max-sm:text-body"
                hint={
                  <Delta
                    current={summary.netProfit}
                    previous={comparison?.netProfit}
                  />
                }
              />
              <Metric
                label={t('office.reports.margin')}
                value={
                  <PrivacyValue mask="••%">
                    {percentText(summary.marginBp)}
                  </PrivacyValue>
                }
                valueClassName="max-sm:text-body"
                hint={
                  <Delta
                    current={summary.marginBp / 100}
                    previous={
                      comparison ? comparison.marginBp / 100 : undefined
                    }
                    points
                  />
                }
              />
            </>
          ) : null}
          {bundle.taxEnabled || summary.tax !== 0 ? (
            <Metric
              label={t('office.reports.tax_collected')}
              value={<MoneyText paisa={summary.tax} />}
              valueClassName="max-sm:text-body"
            />
          ) : null}
        </div>
      ) : null}

      {!hasActivity ? (
        <EmptyState
          icon={<ReportsIcon />}
          message={t('office.reports.no_data')}
        />
      ) : (
        <>
          {singleDay && activeHours.length >= 3 ? (
            <section
              data-testid="report-chart"
              className="rounded-card border border-border bg-surface p-3"
            >
              <h2 className="mb-2 text-title font-semibold">
                {t('office.reports.hourly_chart')}
              </h2>
              <HourlyChart points={summary.hourly} t={t} />
            </section>
          ) : singleDay && singleHour ? (
            <p
              data-testid="report-chart"
              className="text-small text-text-muted"
            >
              {t('office.reports.hourly_single')} ·{' '}
              <span className="tabular-nums">
                {`${String(singleHour.hour).padStart(2, '0')}:00`}
              </span>{' '}
              · <MoneyText paisa={singleHour.sold} />
            </p>
          ) : !singleDay && activeDays > 1 ? (
            <section
              data-testid="report-chart"
              className="rounded-card border border-border bg-surface p-3"
            >
              <h2 className="mb-2 text-title font-semibold">
                {t('office.reports.daily_chart')}
              </h2>
              <DailyChart
                points={summary.daily}
                showProfit={cost}
                lang={lang}
                t={t}
              />
            </section>
          ) : !singleDay ? (
            <p className="text-small text-text-muted">
              {t('office.reports.not_enough_days')}
            </p>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded-card border border-border bg-surface p-3">
              <h2 className="mb-2 text-title font-semibold">
                {t('office.reports.payment_mix')}
              </h2>
              <PaymentMixBar mix={summary.paymentMix} t={t} />
            </section>
            <section className="rounded-card border border-border bg-surface p-3">
              <h2 className="mb-2 text-title font-semibold">
                {t('office.reports.udhaar')}
              </h2>
              <dl className="grid grid-cols-1 gap-3 text-small sm:grid-cols-2">
                <div>
                  <dt className="text-text-muted">
                    {t('office.reports.udhaar_given')}
                  </dt>
                  <dd className="text-h2 font-semibold lg:text-title">
                    <MoneyText paisa={summary.udhaarGiven} />
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">
                    {t('office.reports.udhaar_received')}
                  </dt>
                  <dd className="text-h2 font-semibold lg:text-title">
                    <MoneyText paisa={summary.udhaarReceived} />
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-small text-text-muted">
                {t('office.reports.refunds_note', {
                  count: summary.refundCount,
                  amount: money(summary.refunded),
                })}
              </p>
            </section>
          </div>
        </>
      )}
    </>
  );
}

function productName(product: MasterRow, lang: string): string {
  return lang === 'ur' && String(product.name_ur ?? '').trim() !== ''
    ? String(product.name_ur)
    : String(product.name_en);
}

function ProductsTab({
  bundle,
  cost,
  lang,
  slowMoversReady,
}: {
  bundle: ReportBundle;
  cost: boolean;
  lang: string;
  slowMoversReady: boolean;
}) {
  const { t } = useTranslation();
  const products = bundle.products;
  const slowMovers = products.slowMovers;
  const name = (row: { name: string; nameUr?: string }) =>
    groupName({ name: row.name, nameUr: row.nameUr ?? '' }, lang);
  return (
    <>
      <ReportTable
        title={t('office.reports.best_qty')}
        testId="report-best-qty"
        headers={[
          t('office.reports.product'),
          t('office.reports.qty'),
          t('office.reports.revenue'),
        ]}
        rows={products.bestByQty.map((row) => [
          name(row),
          qtyText(row.qtyMilli, row.unit),
          <MoneyText key="revenue" paisa={row.revenue} />,
        ])}
        rowKeys={products.bestByQty.map(
          (row) => row.productId ?? `missing:${row.key}`,
        )}
        empty={t('office.reports.no_products')}
      />
      <ReportTable
        title={t('office.reports.best_revenue')}
        headers={[
          t('office.reports.product'),
          t('office.reports.qty'),
          t('office.reports.revenue'),
        ]}
        rows={products.bestByRevenue.map((row) => [
          name(row),
          qtyText(row.qtyMilli, row.unit),
          <MoneyText key="revenue" paisa={row.revenue} />,
        ])}
        rowKeys={products.bestByRevenue.map(
          (row) => row.productId ?? `missing:${row.key}`,
        )}
        empty={t('office.reports.no_products')}
      />
      {cost ? (
        <ReportTable
          title={t('office.reports.profit_by_product')}
          headers={[
            t('office.reports.product'),
            t('office.reports.revenue'),
            t('office.reports.cost'),
            t('office.reports.profit'),
            t('office.reports.margin'),
          ]}
          rowKeys={products.bestByProfit.map(
            (row) => row.productId ?? `missing:${row.key}`,
          )}
          rows={products.bestByProfit.map((row) => [
            name(row),
            <MoneyText key="revenue" paisa={row.revenue} />,
            <MoneyText key="cost" paisa={row.cost} />,
            <MoneyText key="profit" paisa={row.profit} />,
            row.revenue > 0 ? (
              <PrivacyValue key="margin" mask="••%">
                {percentText(mulDivRound(row.profit, 10000, row.revenue))}
              </PrivacyValue>
            ) : (
              '—'
            ),
          ])}
          empty={t('office.reports.no_products')}
        />
      ) : null}
      <ReportTable
        title={t('office.reports.by_category')}
        headers={[
          t('office.reports.category'),
          t('office.reports.qty'),
          t('office.reports.revenue'),
        ]}
        rows={products.categories.map((row) => [
          row.key === 'none'
            ? t('office.reports.uncategorized')
            : groupName(row, lang),
          qtyText(row.qtyMilli),
          <MoneyText key="revenue" paisa={row.revenue} />,
        ])}
        rowKeys={products.categories.map((row) => row.key)}
        empty={t('office.reports.no_products')}
      />
      <ReportTable
        title={t('office.reports.by_brand')}
        headers={[
          t('office.reports.brand'),
          t('office.reports.qty'),
          t('office.reports.revenue'),
        ]}
        rows={products.brands.map((row) => [
          row.key === '' ? t('office.reports.no_brand') : row.name,
          qtyText(row.qtyMilli),
          <MoneyText key="revenue" paisa={row.revenue} />,
        ])}
        rowKeys={products.brands.map((row) => `brand:${row.key}`)}
        empty={t('office.reports.no_products')}
      />
      <ReportTable
        title={t('office.reports.slow_movers')}
        testId="report-slow-movers"
        headers={[
          t('office.reports.product'),
          t('office.reports.on_hand'),
          t('office.reports.last_sale'),
        ]}
        rows={(slowMovers ?? []).map((row) => [
          productName(row.product, lang),
          qtyText(row.onHand, String(row.product.unit ?? 'pc')),
          row.lastSale
            ? longDate(row.lastSale, lang)
            : t('office.reports.never_sold'),
        ])}
        rowKeys={(slowMovers ?? []).map((row) => String(row.product.id))}
        empty={
          slowMoversReady
            ? t('office.reports.no_slow_movers')
            : t('office.loading')
        }
      />
    </>
  );
}

function StockTab({
  bundle,
  cost,
  lang,
}: {
  bundle: ReportBundle;
  cost: boolean;
  lang: string;
}) {
  const { t } = useTranslation();
  const stock = bundle.stock;
  const statusLabel = (status: string) => t(`office.reports.status_${status}`);
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cost ? (
          <li>
            <Metric
              label={t('office.reports.stock_value')}
              value={<MoneyText paisa={stock.value} />}
            />
          </li>
        ) : null}
        <li>
          <Metric
            label={t('office.reports.low_stock')}
            value={stock.lowStock.length}
          />
        </li>
        <li>
          <Metric
            label={t('office.reports.out_of_stock')}
            value={stock.outOfStock.length}
          />
        </li>
        <li>
          <Metric
            label={t('office.reports.negative_stock')}
            value={stock.negativeStock.length}
          />
        </li>
      </ul>

      <ReportTable
        title={t('office.reports.needs_attention')}
        testId="report-stock-attention"
        headers={[
          t('office.reports.product'),
          t('office.reports.on_hand'),
          t('office.reports.min_stock'),
          t('office.reports.status'),
          ...(cost ? [t('office.reports.stock_value')] : []),
        ]}
        rows={stock.attention.map((row) => [
          productName(row.product, lang),
          qtyText(row.onHand, String(row.product.unit ?? 'pc')),
          qtyText(
            Number(row.product.min_stock_milli ?? 0),
            String(row.product.unit ?? 'pc'),
          ),
          statusLabel(row.status),
          ...(cost ? [<MoneyText key="value" paisa={row.value} />] : []),
        ])}
        rowKeys={stock.attention.map((row) => String(row.product.id))}
        empty={t('office.reports.no_stock_issues')}
      />

      <ReportTable
        title={t('office.reports.movement_summary')}
        headers={[
          t('office.reports.reason'),
          t('office.reports.movements'),
          t('office.reports.in_qty'),
          t('office.reports.out_qty'),
          t('office.reports.net_qty'),
        ]}
        rows={stock.movements.map((row) => [
          t(`stock.reason.${row.reason}`),
          row.count,
          qtyText(row.inQty),
          qtyText(row.outQty),
          qtyText(row.netQty),
        ])}
        rowKeys={stock.movements.map((row) => row.reason)}
        empty={t('office.reports.no_movements')}
      />

      <section className="flex flex-col gap-2">
        <h2 className="text-title font-semibold">
          {t('office.reports.supplier_returns')}
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <li>
            <Metric
              label={t('office.reports.returns_count')}
              value={stock.supplierReturns.count}
            />
          </li>
          <li>
            <Metric
              label={t('office.reports.returns_credit')}
              value={<MoneyText paisa={stock.supplierReturns.credit} />}
            />
          </li>
          <li>
            <Metric
              label={t('office.reports.returns_difference')}
              value={<MoneyText paisa={stock.supplierReturns.difference} />}
            />
          </li>
        </ul>
        <p className="text-small text-text-muted">
          {t('office.reports.returns_hint')}
        </p>
        {stock.supplierReturns.rows.length > 0 ? (
          <ReportTable
            title={t('office.reports.supplier_returns')}
            headers={[
              t('office.reports.date'),
              t('office.reports.supplier'),
              t('office.reports.credit'),
              t('office.reports.returns_difference'),
            ]}
            rowKeys={stock.supplierReturns.rows.map(
              (row, index) => `${row.date}-${row.supplierId}-${index}`,
            )}
            rows={stock.supplierReturns.rows.map((row) => [
              longDate(row.date, lang),
              row.supplierName,
              <MoneyText key="credit" paisa={row.total} />,
              <MoneyText key="difference" paisa={row.difference} />,
            ])}
            empty={t('office.reports.no_returns')}
          />
        ) : null}
      </section>
    </>
  );
}

function UdhaarTab({ bundle, lang }: { bundle: ReportBundle; lang: string }) {
  const { t } = useTranslation();
  const udhaar = bundle.udhaar;
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <li>
          <Metric
            label={t('office.reports.total_owed')}
            testId="report-udhaar-total"
            value={<MoneyText paisa={udhaar.totalOwed} />}
          />
        </li>
        <li>
          <Metric
            label={t('office.reports.customers_owing')}
            value={udhaar.count}
          />
        </li>
      </ul>
      <p className="text-small text-text-muted">
        {t('office.reports.udhaar_range_note')}
      </p>
      <ReportTable
        title={t('office.reports.aging')}
        headers={[
          t('office.reports.bucket'),
          t('office.reports.customers'),
          t('office.reports.balance'),
        ]}
        rowKeys={udhaar.buckets.map((bucket) => bucket.key)}
        rows={udhaar.buckets.map((bucket) => [
          bucketLabel(t, bucket.key),
          bucket.count,
          <MoneyText key="balance" paisa={bucket.total} />,
        ])}
        empty={t('office.reports.no_udhaar')}
      />
      <ReportTable
        title={t('office.reports.top_debtors')}
        testId="report-top-debtors"
        headers={[
          t('office.reports.customer'),
          t('office.reports.phone'),
          t('office.reports.balance'),
          t('office.reports.age_days'),
          t('office.reports.promise_date'),
        ]}
        rowKeys={udhaar.top.map((row) => String(row.customer.id))}
        rows={udhaar.top.map((row) => [
          String(row.customer.name),
          <span key="phone" dir="ltr">
            {String(row.customer.phone ?? '')}
          </span>,
          <MoneyText key="balance" paisa={row.balance} />,
          row.ageDays,
          row.promiseDate ? longDate(row.promiseDate, lang) : '—',
        ])}
        empty={t('office.reports.no_udhaar')}
      />
    </>
  );
}

function StaffTab({ bundle }: { bundle: ReportBundle }) {
  const { t } = useTranslation();
  return (
    <ReportTable
      title={t('office.reports.tab_staff')}
      testId="report-staff"
      headers={[
        t('office.reports.cashier'),
        t('office.reports.bills'),
        t('office.reports.sold'),
        t('office.reports.discounts'),
        t('office.reports.refunds'),
        t('office.reports.refunded_amount'),
        t('office.reports.voids'),
        t('office.reports.voided_amount'),
        t('office.reports.net_sold'),
      ]}
      rowKeys={bundle.staff.map((row) => row.staffId)}
      rows={bundle.staff.map((row) => [
        row.name,
        row.bills,
        <MoneyText key="sold" paisa={row.sold} />,
        <MoneyText key="discounts" paisa={row.discounts} />,
        row.refunds,
        <MoneyText key="refunded" paisa={row.refunded} />,
        row.voids,
        <MoneyText key="voided" paisa={row.voided} />,
        <MoneyText key="net" paisa={row.netSold} />,
      ])}
      empty={t('office.reports.no_staff')}
    />
  );
}

function DayCloseTab({ bundle, lang }: { bundle: ReportBundle; lang: string }) {
  const { t } = useTranslation();
  const closes = bundle.dayCloses;
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <li>
          <Metric
            label={t('office.reports.closes')}
            value={closes.rows.length}
          />
        </li>
        <li>
          <Metric
            label={t('office.reports.expected')}
            value={<MoneyText paisa={closes.expected} />}
          />
        </li>
        <li>
          <Metric
            label={t('office.reports.counted')}
            value={<MoneyText paisa={closes.counted} />}
          />
        </li>
        <li>
          <Metric
            label={t('office.reports.shorts')}
            value={
              <span>
                {closes.shortCount} · <MoneyText paisa={closes.shortTotal} />
              </span>
            }
          />
        </li>
        <li>
          <Metric
            label={t('office.reports.overs')}
            value={
              <span>
                {closes.overCount} · <MoneyText paisa={closes.overTotal} />
              </span>
            }
          />
        </li>
      </ul>
      <ReportTable
        title={t('office.reports.tab_day_closes')}
        testId="report-day-closes"
        headers={[
          t('office.reports.date'),
          t('office.reports.device'),
          t('office.reports.cashier'),
          t('office.reports.expected'),
          t('office.reports.counted'),
          t('office.reports.difference'),
          t('office.reports.note'),
        ]}
        rowKeys={closes.rows.map((row) => String(row.close.id))}
        rows={closes.rows.map((row) => [
          longDate(String(row.close.business_date), lang),
          row.deviceName,
          row.staffName,
          <MoneyText key="expected" paisa={Number(row.close.expected_cash)} />,
          <MoneyText key="counted" paisa={Number(row.close.counted_cash)} />,
          <span
            key="difference"
            className={
              Number(row.close.difference) === 0
                ? 'text-success-subtle-ink'
                : Number(row.close.difference) < 0
                  ? 'text-danger'
                  : 'text-warning-subtle-ink'
            }
          >
            <MoneyText paisa={Number(row.close.difference)} />
          </span>,
          String(row.close.note ?? '') || '—',
        ])}
        empty={t('office.reports.no_closes')}
      />
    </>
  );
}

function ExpensesTab({ bundle, lang }: { bundle: ReportBundle; lang: string }) {
  const { t } = useTranslation();
  return (
    <>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <li>
          <Metric
            label={t('office.reports.total_expenses')}
            testId="report-expenses-total"
            value={<MoneyText paisa={bundle.expenses.total} />}
          />
        </li>
      </ul>
      <ReportTable
        title={t('office.reports.expenses_by_category')}
        testId="report-expenses"
        headers={[
          t('office.reports.category'),
          t('office.reports.amount'),
          t('office.reports.share'),
        ]}
        rowKeys={bundle.expenses.rows.map((row) =>
          String(row.category?.id ?? 'none'),
        )}
        rows={bundle.expenses.rows.map((row) => [
          row.category
            ? categoryName(row.category, lang)
            : t('office.reports.uncategorized'),
          <MoneyText key="amount" paisa={row.amount} />,
          <PrivacyValue key="share" mask="••%">
            {percentText(row.shareBp)}
          </PrivacyValue>,
        ])}
        empty={t('office.reports.no_expenses')}
      />
    </>
  );
}
