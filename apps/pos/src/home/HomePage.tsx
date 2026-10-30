import { businessDate, type Permission } from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import {
  ClockIcon,
  ProductsIcon,
  SalesIcon,
  SearchIcon,
  SellIcon,
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
import { formatTimestamp } from '../lib/date';
import { formatShopMoney } from '../lib/money';
import { NAV } from '../shell/nav.ts';
import { usePriceCheck } from '../shell/priceCheckStore.ts';
import { useOnline } from '../shell/TopBarParts.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useSession } from '../state/session.ts';

type HomeData = {
  branchName: string;
  products: number;
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

  const data = useLiveQuery(async (): Promise<HomeData> => {
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
      recent: await recentBills(db),
    };
  }, [today, yesterday, role]);

  const dateText = formatTimestamp(
    now,
    i18n.language,
    'Asia/Karachi',
    'weekdayLong',
  );
  const timeText = (at: number) =>
    formatTimestamp(at, i18n.language, 'Asia/Karachi', 'time');

  const tiles: QuickTile[] = [
    {
      to: '/day-close',
      label: 'home.day_close',
      desc: 'home.desc_day_close',
      keys: 'D',
      Icon: ClockIcon,
      perm: 'dayclose.create' as const,
    },
    ...NAV.slice(2).map((item) => ({
      to: item.to,
      label: item.label,
      desc: QUICK_DESC[item.to] ?? 'home.quick_actions',
      keys: item.keys,
      Icon: item.Icon,
      perm: item.perm,
    })),
  ].filter((tile) => tile.perm === null || can(tile.perm));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 lg:p-6">
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
          {online ? null : (
            <span className="rounded-full bg-warning-subtle px-2 py-0.5 text-warning-subtle-ink">
              {t('home.as_of_device')}
            </span>
          )}
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
          <QuickActions tiles={tiles} />
          <RecentBillsCard data={data} timeText={timeText} />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <div className="contents lg:col-start-1 lg:flex lg:flex-col lg:gap-6">
            <Link
              to="/sell"
              className="group order-1 flex min-h-24 items-center gap-4 rounded-card border border-primary/30 bg-primary-subtle p-4 shadow-card hover:border-primary"
            >
              <span className="flex size-12 shrink-0 items-center justify-center rounded-control bg-primary text-primary-ink">
                <SellIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-title font-semibold">
                  {t('home.new_sale')}
                </span>
                <span className="block text-small text-primary-subtle-ink">
                  {t('home.new_sale_hint')}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="text-title text-primary rtl:rotate-180"
              >
                ›
              </span>
            </Link>

            <div className="order-3">
              <QuickActions tiles={tiles} />
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
          </div>

          <aside className="contents lg:col-start-2 lg:flex lg:flex-col lg:gap-4">
            <div className="order-2">
              {data ? (
                <RegisterCard
                  data={data}
                  showCash={can('dayclose.view_expected')}
                  showProfit={can('cost.view')}
                  canClose={can('dayclose.create')}
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

function QuickActions({ tiles }: { tiles: readonly QuickTile[] }) {
  const { t, i18n } = useTranslation();
  const openPriceCheck = usePriceCheck((s) => s.setOpen);
  return (
    <section aria-labelledby="quick-heading">
      <h2 id="quick-heading" className={`mb-2 ${sectionLabel(i18n.language)}`}>
        {t('home.quick_actions')}
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map((tile) => (
          <li key={tile.to + tile.label}>
            <Link
              to={tile.to}
              title={`${t(tile.label)} (${tile.keys})`}
              className="group flex min-h-20 items-start gap-3 rounded-card border border-border bg-surface p-3 text-start shadow-card hover:border-border-strong hover:bg-surface-2"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary-subtle text-primary-subtle-ink">
                <tile.Icon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-small font-medium">
                  {t(tile.label)}
                </span>
                <span className="mt-0.5 block text-small text-text-muted">
                  {t(tile.desc)}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="text-title text-text-muted rtl:rotate-180"
              >
                ›
              </span>
            </Link>
          </li>
        ))}
        <li>
          <button
            type="button"
            title={`${t('home.price_check')} (Ctrl+Shift+P)`}
            onClick={() => openPriceCheck(true)}
            className="group flex min-h-20 w-full items-start gap-3 rounded-card border border-border bg-surface p-3 text-start shadow-card hover:border-border-strong hover:bg-surface-2"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-primary-subtle text-primary-subtle-ink">
              <SearchIcon />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-small font-medium">
                {t('home.price_check')}
              </span>
              <span className="mt-0.5 block text-small text-text-muted">
                {t('home.desc_price_check')}
              </span>
            </span>
            <span
              aria-hidden="true"
              className="text-title text-text-muted rtl:rotate-180"
            >
              ›
            </span>
          </button>
        </li>
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
          <dd className="mt-0.5 flex flex-col gap-0.5 text-body font-medium">
            <span>
              {t('home.udhaar_given', {
                amount: formatShopMoney(data.today.udhaarGiven),
              })}
            </span>
            <span>
              {t('home.udhaar_received', {
                amount: formatShopMoney(data.today.udhaarReceived),
              })}
            </span>
          </dd>
        </div>
      </dl>
      {canClose ? (
        <Link to="/day-close" className={`${buttonQuiet} mt-3 w-full`}>
          {t('home.day_close')}
        </Link>
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
      {recent.length > 0 ? (
        <ul className="divide-y divide-border">
          {recent.map(({ sale, methods }) => (
            <li key={sale.id}>
              <Link
                to="/sales/$id"
                params={{ id: sale.id }}
                className="flex flex-col gap-1 px-4 py-3 hover:bg-surface-2"
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
