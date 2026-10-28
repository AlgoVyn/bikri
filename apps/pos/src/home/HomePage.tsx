import { businessDate, formatMoney } from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import {
  ClockIcon,
  ExpensesIcon,
  ProductsIcon,
  ReportsIcon,
  SalesIcon,
  SearchIcon,
  SellIcon,
  UdhaarIcon,
} from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { getDb } from '../data/db.ts';
import {
  type AttentionItem,
  attentionItems,
  recentBills,
} from '../data/home.ts';
import { defaultBranch, deviceInfo } from '../data/localTenant.ts';
import { expectedCash, summary } from '../data/reports.ts';
import { NAV } from '../shell/nav.ts';
import { usePriceCheck } from '../shell/priceCheckStore.ts';
import { useOnline } from '../shell/TopBarParts.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useSession } from '../state/session.ts';

const DAY_MS = 86_400_000;

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
  const online = useOnline();
  const now = Date.now();
  const today = businessDate(now);
  const yesterday = businessDate(now - DAY_MS);

  const data = useLiveQuery(async () => {
    const db = getDb();
    const device = await deviceInfo(db);
    const branch = await defaultBranch(db);
    const deviceId = device?.id ?? '';
    return {
      branchName: String(branch?.name ?? ''),
      products: await db.products.filter((p) => !p.deleted_at).count(),
      today: await summary(db, { from: today, to: today }),
      cash: await expectedCash(db, deviceId),
      attention: await attentionItems(db, {
        today,
        yesterday,
        deviceId,
        isOwner: role === 'owner',
      }),
      recent: await recentBills(db, deviceId),
    };
  }, [today, yesterday, role]);

  const dateText = new Intl.DateTimeFormat(
    i18n.language === 'ur' ? 'ur-PK' : 'en-PK',
    {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'Asia/Karachi',
    },
  ).format(now);
  const timeFmt = new Intl.DateTimeFormat('en-PK', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Karachi',
  });

  const openPriceCheck = usePriceCheck((s) => s.setOpen);
  const tiles = [
    {
      to: '/sell',
      label: 'home.new_sale',
      keys: 'N',
      Icon: SellIcon,
      perm: 'sale.create' as const,
    },
    {
      to: '/day-close',
      label: 'home.day_close',
      keys: 'D',
      Icon: ClockIcon,
      perm: 'dayclose.create' as const,
    },
    ...NAV.slice(2).map((item) => ({
      to: item.to,
      label: item.label,
      keys: item.keys,
      Icon: item.Icon,
      perm: item.perm,
    })),
  ].filter((tile) => tile.perm === null || can(tile.perm));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 lg:p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
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
            {online ? null : (
              <span className="rounded-full bg-warning-subtle px-2 py-0.5 text-warning-subtle-ink">
                {t('home.as_of_device')}
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 max-sm:hidden">
          {can('sale.create') ? (
            <Link to="/sell" className={`${buttonPrimary} gap-2`}>
              <SellIcon />
              {t('home.new_sale')}
            </Link>
          ) : null}

        </div>
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

      {data && data.products === 0 ? (
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
            {can('catalog.edit') ? (
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
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {data && data.products > 0 ? (
        <section aria-label={t('home.today_summary')}>
          <ul className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <TodayCard
              label={t('home.sold_today')}
              testId="today-sold"
              icon={<SalesIcon />}
              tone="bg-primary-subtle text-primary-subtle-ink"
              value={<MoneyText paisa={data.today.sold} />}
              sub={t('home.bills_count', { count: data.today.bills })}
            />
            {can('cost.view') ? (
              <TodayCard
                label={t('home.profit_today')}
                testId="today-profit"
                icon={<ReportsIcon />}
                tone="bg-success-subtle text-success-subtle-ink"
                value={<MoneyText paisa={data.today.grossProfit} />}
              />
            ) : null}
            {can('dayclose.view_expected') ? (
              <TodayCard
                label={t('home.cash_drawer')}
                testId="today-cash"
                icon={<ExpensesIcon />}
                tone="bg-info-subtle text-info-subtle-ink"
                value={<MoneyText paisa={data.cash} />}
              />
            ) : null}
            <TodayCard
              label={t('home.udhaar_today')}
              testId="today-udhaar"
              icon={<UdhaarIcon />}
              tone="bg-warning-subtle text-warning-subtle-ink"
              value={
                <span className="flex flex-col gap-0.5">
                  <span className="text-body font-medium">
                    {t('home.udhaar_given', {
                      amount: formatMoney(data.today.udhaarGiven),
                    })}
                  </span>
                  <span className="text-body font-medium">
                    {t('home.udhaar_received', {
                      amount: formatMoney(data.today.udhaarReceived),
                    })}
                  </span>
                </span>
              }
            />
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="quick-heading">
        <h2 id="quick-heading" className="mb-2 text-h2 font-semibold">
          {t('home.quick_actions')}
        </h2>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {tiles.map((tile) => (
            <li key={tile.to + tile.label}>
              <Link
                to={tile.to}
                title={`${t(tile.label)} (${tile.keys})`}
                className="group flex min-h-14 items-center gap-3 rounded-card border border-border bg-surface p-3 text-small font-medium shadow-card hover:border-border-strong hover:bg-surface-2"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-text-muted group-hover:bg-primary-subtle group-hover:text-primary-subtle-ink">
                  <tile.Icon />
                </span>
                <span className="min-w-0 truncate">{t(tile.label)}</span>
              </Link>
            </li>
          ))}
          <li>
            <button
              type="button"
              title={`${t('home.price_check')} (Ctrl+Shift+P)`}
              onClick={() => openPriceCheck(true)}
              className="group flex min-h-14 w-full items-center gap-3 rounded-card border border-border bg-surface p-3 text-start text-small font-medium shadow-card hover:border-border-strong hover:bg-surface-2"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-text-muted group-hover:bg-primary-subtle group-hover:text-primary-subtle-ink">
                <SearchIcon />
              </span>
              <span className="min-w-0 truncate">{t('home.price_check')}</span>
            </button>
          </li>
        </ul>
      </section>

      {data && data.attention.length > 0 ? (
        <section aria-labelledby="attention-heading">
          <h2 id="attention-heading" className="mb-2 text-h2 font-semibold">
            {t('home.attention')}
          </h2>
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface shadow-card">
            {data.attention.map((item) => (
              <li key={item.kind}>
                <Link
                  to={ATTENTION_LINK[item.kind] ?? '/'}
                  className={`flex min-h-12 items-center gap-3 px-4 py-3 text-small font-medium hover:bg-surface-2 ${attentionTone(item)}`}
                  data-testid={`attn-${item.kind}`}
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full bg-current"
                  />
                  <span className="min-w-0 flex-1">
                    {attentionText(t, i18n.language, item)}
                  </span>
                  <span
                    aria-hidden="true"
                    className="text-base text-text-muted rtl:rotate-180"
                  >
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
            className="text-small font-medium text-primary hover:underline"
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
        {data && data.recent.length > 0 ? (
          <ul className="divide-y divide-border">
            {data.recent.map(({ sale, methods }) => (
              <li key={sale.id}>
                <Link
                  to="/sales/$id"
                  params={{ id: sale.id }}
                  className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-surface-2"
                >
                  <bdi dir="ltr" className="font-mono text-small font-medium">
                    {String(sale.invoice_no)}
                  </bdi>
                  <bdi dir="ltr" className="text-small text-text-muted">
                    {timeFmt.format(Number(sale.created_at))}
                  </bdi>
                  <span className="flex flex-wrap gap-1">
                    {methods.map((m) => (
                      <span
                        key={m}
                        className="rounded-full bg-surface-2 px-2 py-0.5 text-small text-text-muted"
                      >
                        {t(`payment.${m}`)}
                      </span>
                    ))}
                  </span>
                  <span className="ms-auto text-body font-semibold">
                    <MoneyText paisa={Number(sale.total)} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
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
          timeZone: 'Asia/Karachi',
        }).format(item.since),
      });
    case 'clock_wrong':
      return t('home.attn_clock_wrong');
    default:
      return t(`home.attn_${attentionKey(item.kind)}`, { count: item.count });
  }
}

function TodayCard({
  label,
  testId,
  icon,
  tone,
  value,
  sub,
}: {
  label: string;
  testId: string;
  icon: ReactNode;
  tone: string;
  value: ReactNode;
  sub?: string;
}) {
  return (
    <li
      className="rounded-card border border-border bg-surface p-4 shadow-card"
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-small text-text-muted">{label}</p>
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-control ${tone}`}
        >
          {icon}
        </span>
      </div>
      <div className="mt-2 text-title font-semibold">{value}</div>
      {sub ? <p className="mt-1 text-small text-text-muted">{sub}</p> : null}
    </li>
  );
}
