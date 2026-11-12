import type { Permission } from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import {
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  CountIcon,
  LockIcon,
  ProductsIcon,
  SalesIcon,
  SearchIcon,
  SellIcon,
} from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import {
  type AttentionItem,
  addSampleProducts,
  attentionItems,
  recentBills,
} from '../data/home.ts';
import { defaultBranch, deviceInfo } from '../data/localTenant.ts';
import { expectedCash, summary } from '../data/reports.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { useBusinessDates } from '../data/useBusinessDates.ts';
import { formatTimestamp } from '../lib/date';
import { NAV } from '../shell/nav.ts';
import { usePriceCheck } from '../shell/priceCheckStore.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { useSession } from '../state/session.ts';

type HomeData = {
  branchName: string;
  products: number;
  printer: boolean;
  salesCount: number;
  today: Awaited<ReturnType<typeof summary>>;
  cash: number;
  attention: AttentionItem[];
  recent: Awaited<ReturnType<typeof recentBills>>;
};

type QuickTile = {
  to: string;
  label: string;
  desc: string;
  keys: string;
  Icon: () => React.JSX.Element;
  perm: Permission | null;
  /** Any of these permissions is enough, matching the rail (`permAny`). */
  permAny?: readonly Permission[];
};

const QUICK_DESC: Record<string, string> = {
  '/products': 'home.desc_products',
  '/sales': 'home.desc_sales',
  '/udhaar': 'home.desc_udhaar',
  '/suppliers': 'home.desc_suppliers',
  '/expenses': 'home.desc_expenses',
  '/reports': 'home.desc_reports',
  '/settings': 'home.desc_settings',
};

/** Home groups its actions by the job the cashier is doing (screens/04). */
const RUN_ROUTES = new Set(['/day-close', '/sales', '/udhaar']);

const ATTENTION_LINK: Record<string, string> = {
  low_stock: '/products',
  promises_due: '/udhaar/chase',
  over_limit: '/udhaar',
  failed_prints: '/settings',
  conflicts: '/settings/sync',
  sync_stale: '/settings/sync',
  sync_pending_old: '/settings/sync',
  clock_wrong: '/settings/sync',
  day_not_closed: '/day-close',
  held_expiring: '/sell',
};

/** Home (screens/04). */
export function HomePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const justSetUp = useSession((s) => s.justSetUp);
  const setJustSetUp = useSession((s) => s.setJustSetUp);
  const { staff, role, can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const toast = useToast();
  const [samplePending, setSamplePending] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    try {
      return localStorage.getItem('bikri.onboarding_dismissed') === '1';
    } catch {
      return false;
    }
  });
  const timeZone =
    useLiveQuery(() => shopTimeZone(getDb()), []) ?? 'Asia/Karachi';
  const { today, yesterday, now } = useBusinessDates(timeZone);

  const data = useLiveQuery(async (): Promise<HomeData> => {
    const db = getDb();
    const device = await deviceInfo(db);
    const branch = await defaultBranch(db);
    const deviceId = device?.id ?? '';
    return {
      branchName: String(branch?.name ?? ''),
      products: await db.products.filter((p) => !p.deleted_at).count(),
      printer: Boolean((await db.kv.get('printer'))?.value),
      salesCount: await db.sales.filter((s) => s.status !== 'void').count(),
      today: await summary(db, { from: today, to: today }),
      cash: await expectedCash(db, deviceId),
      attention: await attentionItems(db, {
        today,
        yesterday,
        deviceId,
        isOwner: role === 'owner',
      }),
      recent: await recentBills(db),
    };
  }, [today, yesterday, role]);

  const dateText = formatTimestamp(now, i18n.language, timeZone, 'weekdayLong');
  const timeText = (at: number) =>
    formatTimestamp(at, i18n.language, timeZone, 'time');

  const loadSamples = async () => {
    if (!staff || readOnly) return;
    setSamplePending(true);
    try {
      const count = await addSampleProducts(getDb(), staff.id);
      toast.push(t('home.samples_loaded', { count }));
    } catch {
      toast.push(t('errors.generic'), 'error');
    } finally {
      setSamplePending(false);
    }
  };

  const tiles: QuickTile[] = [
    {
      to: '/day-close',
      label: 'home.day_close',
      desc: 'home.desc_day_close',
      keys: 'D',
      Icon: ClockIcon,
      perm: 'dayclose.create' as const,
    },
    ...NAV.slice(2, 3).map((item) => ({
      to: item.to,
      label: item.label,
      desc: QUICK_DESC[item.to] ?? 'home.quick_actions',
      keys: item.keys,
      Icon: item.Icon,
      perm: item.perm,
      ...(item.permAny ? { permAny: item.permAny } : {}),
    })),
    {
      to: '/stock/count',
      label: 'count.title',
      desc: 'home.desc_count',
      keys: '',
      Icon: CountIcon,
      perm: 'stock.adjust' as const,
    },
    ...NAV.slice(3).map((item) => ({
      to: item.to,
      label: item.label,
      desc: QUICK_DESC[item.to] ?? 'home.quick_actions',
      keys: item.keys,
      Icon: item.Icon,
      perm: item.perm,
      ...(item.permAny ? { permAny: item.permAny } : {}),
    })),
  ].filter((tile) =>
    !readOnly || tile.to !== '/day-close'
      ? tile.permAny !== undefined
        ? tile.permAny.some((permission) => can(permission))
        : tile.perm === null || can(tile.perm)
      : false,
  );

  const runTiles = tiles.filter((tile) => RUN_ROUTES.has(tile.to));
  const manageTiles = tiles.filter((tile) => !RUN_ROUTES.has(tile.to));

  return (
    <div className={pageClass('standard', 'gap-6')}>
      <header>
        <h1 className="text-h1 font-semibold">
          {t('home.greeting', { name: String(staff?.name ?? '') })}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-text-muted">
          <span>{dateText}</span>
          {data?.branchName ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{data.branchName}</span>
            </>
          ) : null}
        </p>
      </header>

      {justSetUp ? (
        <section
          className="rounded-card border border-border bg-surface p-4 shadow-card"
          aria-labelledby="ready-heading"
        >
          <h2 id="ready-heading" className="text-h2 font-semibold">
            {t('setup.ready')}
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => {
                setJustSetUp(false);
                void navigate({ to: '/sell' });
              }}
            >
              {t('setup.start_selling')}
            </button>
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => {
                setJustSetUp(false);
                void navigate({ to: '/settings' });
              }}
            >
              {t('setup.setup_printer')}
            </button>
          </div>
        </section>
      ) : null}

      {data &&
      role === 'owner' &&
      data.products > 0 &&
      !onboardingDismissed &&
      !(data.products > 0 && data.printer && data.salesCount > 0) ? (
        <GettingStarted
          products={data.products}
          printer={data.printer}
          hasSale={data.salesCount > 0}
          samplePending={samplePending}
          samplesDisabled={readOnly}
          onSamples={() => void loadSamples()}
          onDismiss={() => {
            try {
              localStorage.setItem('bikri.onboarding_dismissed', '1');
            } catch {
              // Storage may be disabled.
            }
            setOnboardingDismissed(true);
          }}
        />
      ) : null}

      {data && data.products === 0 ? (
        <div className="flex flex-col gap-6">
          <section
            className="rounded-card border border-border bg-surface p-4 shadow-card"
            aria-labelledby="first-heading"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary-subtle text-primary-subtle-ink">
                <ProductsIcon />
              </span>
              <div className="min-w-0">
                <h2 id="first-heading" className="text-h2 font-semibold">
                  {t('home.first_products')}
                </h2>
                <p className="mt-1 text-text-muted">{t('home.no_products')}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {can('catalog.edit') && !readOnly ? (
                <>
                  <Link to="/products/new" className={buttonPrimary}>
                    {t('home.add_product')}
                  </Link>
                  <Link to="/products/import" className={buttonQuiet}>
                    {t('home.import')}
                  </Link>
                  <Link to="/products/suggested" className={buttonQuiet}>
                    {t('home.suggested')}
                  </Link>
                  <button
                    type="button"
                    className="min-h-11 self-center text-small font-medium text-primary underline"
                    disabled={samplePending || readOnly}
                    onClick={() => void loadSamples()}
                  >
                    {t('home.load_samples')}
                  </button>
                </>
              ) : null}
            </div>
          </section>
          <div className="flex flex-col gap-6">
            <QuickActions
              tiles={runTiles}
              label="home.run_till"
              showPriceCheck
              columns={2}
            />
            <QuickActions tiles={manageTiles} label="home.manage" />
          </div>
          <RecentBillsCard data={data} timeText={timeText} />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <div className="contents lg:col-start-1 lg:flex lg:flex-col lg:gap-6">
            {readOnly ? (
              <section
                aria-labelledby="read-only-heading"
                className="order-1 flex flex-col gap-3 rounded-card border border-warning/30 bg-warning-subtle p-4 text-warning-subtle-ink shadow-card"
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-12 shrink-0 items-center justify-center rounded-control bg-warning/15"
                  >
                    <LockIcon />
                  </span>
                  <div className="min-w-0">
                    <h2
                      id="read-only-heading"
                      className="text-title font-semibold"
                    >
                      {t('home.read_only_title')}
                    </h2>
                    <p className="sr-only">{t('home.read_only_hint')}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link to="/reports" className={buttonPrimary}>
                    {t('nav.reports')}
                  </Link>
                  {can('export.data') ? (
                    <Link to="/settings/backup" className={buttonQuiet}>
                      {t('home.export_data')}
                    </Link>
                  ) : null}
                </div>
              </section>
            ) : (
              <Link
                to="/sell"
                className="group relative order-1 flex min-h-24 items-center gap-4 overflow-hidden rounded-card border-2 border-accent bg-rail p-4 text-rail-ink shadow-card transition-colors duration-150 hover:border-accent"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -end-8 -top-12 size-40 rounded-full bg-white/5"
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -bottom-16 end-16 size-32 rounded-full bg-accent/10"
                />
                <span className="relative flex size-12 shrink-0 items-center justify-center rounded-control bg-accent text-accent-ink">
                  <SellIcon />
                </span>
                <span className="relative min-w-0 flex-1">
                  <span className="block text-title font-semibold text-rail-ink">
                    {t('home.new_sale')}
                  </span>
                  <span className="block text-small text-rail-muted">
                    {t('home.new_sale_hint')}
                  </span>
                </span>
                <ChevronRightIcon className="size-4 relative text-title text-rail-active rtl:rotate-180" />
              </Link>
            )}

            <div className="order-3 flex flex-col gap-6">
              <QuickActions
                tiles={runTiles}
                label="home.run_till"
                showPriceCheck
                columns={2}
              />
              <QuickActions tiles={manageTiles} label="home.manage" />
            </div>

            {data && data.attention.length > 0 ? (
              <section aria-labelledby="attention-heading" className="order-5">
                <h2
                  id="attention-heading"
                  className="mb-2 text-small font-semibold text-text-muted"
                >
                  {t('home.attention')}
                </h2>
                <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface shadow-card">
                  {data.attention.map((item) => (
                    <li key={item.kind}>
                      <Link
                        to={ATTENTION_LINK[item.kind] ?? '/'}
                        className={`flex min-h-12 items-center gap-3 px-4 py-3 text-small font-medium transition-colors duration-150 hover:bg-surface-2 ${attentionTone(item)}`}
                        data-testid={`attn-${item.kind}`}
                      >
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-full bg-current"
                        />
                        <span className="min-w-0 flex-1">
                          {attentionText(t, i18n.language, timeZone, item)}
                        </span>
                        <ChevronRightIcon className="size-4 text-base text-text-muted rtl:rotate-180" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <aside className="contents lg:col-start-2 lg:flex lg:flex-col lg:gap-4">
            <div className="order-2">
              {data ? (
                <RegisterCard
                  data={data}
                  showCash={can('dayclose.view_expected')}
                  showProfit={can('cost.view')}
                  canClose={can('dayclose.create') && !readOnly}
                  timeText={timeText}
                />
              ) : null}
            </div>
            <div className="order-4">
              <RecentBillsCard data={data} timeText={timeText} />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function sectionLabel(_lang: string): string {
  return 'text-small font-semibold text-text-muted';
}

function GettingStarted({
  products,
  printer,
  hasSale,
  samplePending,
  samplesDisabled,
  onSamples,
  onDismiss,
}: {
  products: number;
  printer: boolean;
  hasSale: boolean;
  samplePending: boolean;
  samplesDisabled: boolean;
  onSamples: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const steps = [
    {
      done: products > 0,
      to: '/products/new' as const,
      title: t('home.step_products'),
      hint: t('home.step_products_hint'),
      action:
        products > 0 ? null : (
          <div className="flex flex-wrap gap-2">
            <Link to="/products/new" className={buttonPrimary}>
              {t('home.add_product')}
            </Link>
            <button
              type="button"
              className={buttonQuiet}
              disabled={samplePending || samplesDisabled}
              onClick={onSamples}
            >
              {t('home.load_samples')}
            </button>
            <Link
              to="/products/import"
              className="self-center text-small text-primary hover:underline"
            >
              {t('home.import')}
            </Link>
          </div>
        ),
    },
    {
      done: printer,
      to: '/settings/printer' as const,
      title: t('home.step_printer'),
      hint: t('home.step_printer_hint'),
      action: printer ? null : (
        <Link to="/settings/printer" className={buttonQuiet}>
          {t('home.step_printer')}
        </Link>
      ),
    },
    {
      done: hasSale,
      to: '/sell' as const,
      title: t('home.step_sale'),
      hint: t('home.step_sale_hint'),
      action: hasSale ? null : (
        <Link to="/sell" className={buttonQuiet}>
          {t('home.step_sale')}
        </Link>
      ),
    },
  ];
  const done = steps.filter((step) => step.done).length;
  const pending = steps
    .map((step, index) => ({ ...step, number: index + 1 }))
    .filter((step) => !step.done);

  if (pending.length === 0) return null;

  const progress = (done / steps.length) * 100;

  // Once the catalogue exists, the remaining setup is one optional step. A full checklist
  // card would outweigh the New sale hero; keep it as a compact strip.
  if (products > 0) {
    const step = pending[0];
    if (!step) return null;
    return (
      <section
        aria-labelledby="getting-started"
        data-testid="getting-started"
        className="rounded-card border border-border bg-surface p-3 shadow-card"
      >
        <div className="flex items-center gap-2">
          <h2 id="getting-started" className="me-auto text-title font-semibold">
            {t('home.get_started')}
          </h2>
          <span className="text-small text-text-muted tabular-nums">
            {t('home.steps_progress', { done, total: steps.length })}
          </span>
          <button
            type="button"
            className="flex size-11 items-center justify-center rounded-control text-text-muted hover:bg-surface-2"
            aria-label={t('common.dismiss')}
            onClick={onDismiss}
          >
            <CloseIcon className="size-5 text-title leading-none" />
          </button>
        </div>
        <Link
          to={step.to}
          className="mt-2 flex min-h-11 items-center gap-3 rounded-control px-1 hover:bg-surface-2"
        >
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-small font-semibold text-text-muted"
          >
            {step.number}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">{step.title}</p>
            <p className="text-small text-text-muted">{step.hint}</p>
          </div>
          <ChevronRightIcon className="size-4 text-title leading-none text-text-muted rtl:rotate-180" />
        </Link>
        <div
          role="progressbar"
          aria-label={t('home.steps_progress', {
            done,
            total: steps.length,
          })}
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2"
        >
          <div
            className="h-full rounded-full bg-success transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="getting-started"
      data-testid="getting-started"
      className="overflow-hidden rounded-card border border-border bg-surface shadow-card"
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <h2 id="getting-started" className="me-auto text-h2 font-semibold">
          {t('home.get_started')}
        </h2>
        <span className="text-small text-text-muted tabular-nums">
          {t('home.steps_progress', { done, total: steps.length })}
        </span>
        <button
          type="button"
          className="flex size-11 items-center justify-center rounded-control text-text-muted hover:bg-surface-2"
          aria-label={t('common.dismiss')}
          onClick={onDismiss}
        >
          <CloseIcon className="size-5 text-title leading-none" />
        </button>
      </div>
      <div className="px-4 pb-3">
        <div
          role="progressbar"
          aria-label={t('home.steps_progress', {
            done,
            total: steps.length,
          })}
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          className="h-1.5 overflow-hidden rounded-full bg-surface-2"
        >
          <div
            className="h-full rounded-full bg-success transition-[width] duration-200"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <ol className="divide-y divide-border border-t border-border">
        {pending.map((step) => (
          <li key={step.title} className="flex gap-3 px-4 py-3">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-small font-semibold text-text-muted"
            >
              {step.number}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{step.title}</p>
              <p className="mt-0.5 text-small text-text-muted">{step.hint}</p>
              {step.action ? <div className="mt-2">{step.action}</div> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function QuickActions({
  tiles,
  label,
  showPriceCheck = false,
  columns = 3,
}: {
  tiles: readonly QuickTile[];
  label: string;
  showPriceCheck?: boolean;
  columns?: 2 | 3;
}) {
  const { t, i18n } = useTranslation();
  const openPriceCheck = usePriceCheck((s) => s.setOpen);
  const grid =
    columns === 2
      ? 'grid gap-2 sm:grid-cols-2 xl:grid-cols-2'
      : 'grid gap-2 sm:grid-cols-2 xl:grid-cols-3';
  return (
    <section aria-labelledby={`${label}-heading`}>
      <h2
        id={`${label}-heading`}
        className={`mb-2 ${sectionLabel(i18n.language)}`}
      >
        {t(label)}
      </h2>
      <ul className={grid}>
        {tiles.map((tile) => (
          <li key={tile.to + tile.label}>
            <Link
              to={tile.to}
              title={tile.keys ? `${t(tile.label)} (${tile.keys})` : undefined}
              className="group flex min-h-20 items-start gap-3 rounded-card border border-border bg-surface p-3 text-start shadow-card transition-colors duration-150 hover:border-border-strong hover:bg-surface-2 hover:shadow-card-hover"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary-subtle text-primary-subtle-ink">
                <tile.Icon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">
                  {t(tile.label)}
                </span>
                <span className="mt-0.5 block text-small text-text-muted">
                  {t(tile.desc)}
                </span>
              </span>
              <ChevronRightIcon className="size-4 text-title text-text-muted rtl:rotate-180" />
            </Link>
          </li>
        ))}
        {showPriceCheck ? (
          <li>
            <button
              type="button"
              title={`${t('home.price_check')} (Ctrl+Shift+P)`}
              onClick={() => openPriceCheck(true)}
              className="group flex min-h-20 w-full items-start gap-3 rounded-card border border-border bg-surface p-3 text-start shadow-card transition-colors duration-150 hover:border-border-strong hover:bg-surface-2 hover:shadow-card-hover"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary-subtle text-primary-subtle-ink">
                <SearchIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">
                  {t('home.price_check')}
                </span>
                <span className="mt-0.5 block text-small text-text-muted">
                  {t('home.desc_price_check')}
                </span>
              </span>
              <ChevronRightIcon className="size-4 text-title text-text-muted rtl:rotate-180" />
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function RegisterCard({
  data,
  showCash,
  showProfit,
  canClose,
  timeText,
}: {
  data: HomeData;
  showCash: boolean;
  showProfit: boolean;
  canClose: boolean;
  timeText: (at: number) => string;
}) {
  const { t, i18n } = useTranslation();
  const last = data.recent[0]?.sale.created_at;
  return (
    <section
      aria-labelledby="register-heading"
      className="rounded-card border border-border bg-surface p-4 shadow-card"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id="register-heading" className={sectionLabel(i18n.language)}>
          {t('home.todays_register')}
        </h2>
        {last ? (
          <p className="text-small text-text-muted">
            {t('home.last_bill', {
              time: timeText(Number(last)),
            })}
          </p>
        ) : null}
      </div>
      <div className="mt-3" data-testid="today-sold">
        <p className="text-small text-text-muted">{t('home.sold_today')}</p>
        <p className="mt-0.5 text-total font-semibold">
          <MoneyText paisa={data.today.sold} />
        </p>
        <p className="text-small text-text-muted">
          {t('home.bills_count', { count: data.today.bills })}
        </p>
        {data.today.bills === 0 ? (
          <p className="text-small text-text-muted">
            {t('home.no_sales_today')}
          </p>
        ) : null}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4 border-t border-border pt-3">
        {showCash ? (
          <div data-testid="today-cash">
            <dt className="text-small text-text-muted">
              {t('home.cash_drawer')}
            </dt>
            <dd className="mt-0.5 text-body font-semibold">
              <MoneyText paisa={data.cash} />
            </dd>
          </div>
        ) : null}
        {showProfit ? (
          <div data-testid="today-profit">
            <dt className="text-small text-text-muted">
              {t('home.profit_today')}
            </dt>
            <dd className="mt-0.5 text-body font-semibold">
              <MoneyText paisa={data.today.grossProfit} />
            </dd>
          </div>
        ) : null}
        <div data-testid="today-udhaar" className="col-span-2">
          <dt className="text-small text-text-muted">
            {t('home.udhaar_today')}
          </dt>
          <dd className="mt-0.5 flex flex-col gap-1 text-body font-medium">
            <span className="flex items-baseline justify-between gap-3">
              <span>{t('home.udhaar_given')}</span>
              <span className="font-semibold" data-testid="today-udhaar-given">
                <MoneyText paisa={data.today.udhaarGiven} />
              </span>
            </span>
            <span className="flex items-baseline justify-between gap-3">
              <span>{t('home.udhaar_received')}</span>
              <span
                className="font-semibold"
                data-testid="today-udhaar-received"
              >
                <MoneyText paisa={data.today.udhaarReceived} />
              </span>
            </span>
          </dd>
        </div>
      </dl>
      {canClose ? (
        <div className="mt-3 flex justify-end border-t border-border pt-1">
          <Link
            to="/day-close"
            className="inline-flex min-h-11 items-center gap-1 text-small font-medium text-primary"
          >
            {t('home.day_close')}
            <ChevronRightIcon className="size-4 rtl:rotate-180" />
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function RecentBillsCard({
  data,
  timeText,
}: {
  data: HomeData | undefined;
  timeText: (at: number) => string;
}) {
  const { t } = useTranslation();
  const recent = data?.recent ?? [];
  return (
    <section
      aria-labelledby="recent-heading"
      className="overflow-hidden rounded-card border border-border bg-surface shadow-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 id="recent-heading" className="me-auto text-h2 font-semibold">
          {t('home.recent_bills')}
        </h2>
        <Link
          to="/sales"
          className="-mx-1 inline-flex min-h-11 items-center px-1 text-small font-medium text-primary hover:underline"
        >
          {t('home.view_all')}
        </Link>
      </div>
      {data?.recent.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-surface-2 text-text-muted">
            <SalesIcon />
          </span>
          <p className="text-small text-text-muted">{t('home.no_bills')}</p>
        </div>
      ) : null}
      {recent.length > 0 ? (
        <ul className="divide-y divide-border">
          {recent.map(({ sale, methods }) => (
            <li key={sale.id}>
              <Link
                to="/sales/$id"
                params={{ id: sale.id }}
                className="flex flex-col gap-1 px-4 py-3 transition-colors duration-150 hover:bg-surface-2"
              >
                <span className="flex items-center justify-between gap-2">
                  <bdi dir="ltr" className="font-mono text-small font-medium">
                    {String(sale.invoice_no)}
                  </bdi>
                  <span className="text-body font-semibold">
                    <MoneyText paisa={Number(sale.total)} />
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2 text-small text-text-muted">
                  <bdi dir="ltr">{timeText(Number(sale.created_at))}</bdi>
                  {methods.map((m) => (
                    <span
                      key={m}
                      className="rounded-full bg-surface-2 px-2 py-0.5"
                    >
                      {t(`payment.${m}`)}
                    </span>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function attentionKey(kind: string): string {
  return kind === 'promises_due' ? 'promises' : kind;
}

function attentionTone(item: AttentionItem): string {
  if (item.kind === 'sync_stale')
    return item.severe ? 'text-danger' : 'text-warning-subtle-ink';
  if (item.kind === 'clock_wrong' || item.kind === 'sync_pending_old')
    return 'text-warning-subtle-ink';
  return '';
}

function attentionText(
  t: (key: string, opts?: Record<string, unknown>) => string,
  lang: string,
  timeZone: string,
  item: AttentionItem,
): string {
  switch (item.kind) {
    case 'day_not_closed':
      return t('home.attn_day_not_closed', { date: item.date });
    case 'sync_stale':
      return item.severe
        ? t('home.attn_sync_stale_severe', {
            days: Math.max(30 - item.days, 0),
          })
        : t('home.attn_sync_stale', { days: item.days });
    case 'sync_pending_old':
      return t('home.attn_sync_pending_old', {
        time: new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK' : 'en-PK', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone,
        }).format(item.since),
      });
    case 'clock_wrong':
      return t('home.attn_clock_wrong');
    default:
      return t(`home.attn_${attentionKey(item.kind)}`, { count: item.count });
  }
}
