import { businessDate, formatMoney } from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { KeyBadge } from '../components/KeyBadge.tsx';
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
  day_not_closed: '/sales',
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
      perm: 'sale.create' as const,
    },
    ...NAV.slice(2).map((item) => ({
      to: item.to,
      label: item.label,
      keys: item.keys,
      perm: item.perm,
    })),
  ].filter((tile) => tile.perm === null || can(tile.perm));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-h1 font-semibold">
          {t('home.greeting', { name: String(staff?.name ?? '') })}
        </h1>
        <p className="text-text-muted">
          {dateText}
          {data?.branchName ? ` · ${data.branchName}` : ''}
        </p>
      </header>

      {justSetUp ? (
        <section
          className="rounded-card border border-border bg-surface p-4"
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
          className="rounded-card border border-border bg-surface p-4"
          aria-labelledby="first-heading"
        >
          <h2 id="first-heading" className="text-h2 font-semibold">
            {t('home.first_products')}
          </h2>
          <p className="mt-1 text-text-muted">{t('home.no_products')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
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
        <section aria-label={t('home.sold_today')}>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <TodayCard label={t('home.sold_today')} testId="today-sold">
              <MoneyText paisa={data.today.sold} />
              <span className="block text-small text-text-muted">
                {t('home.bills_count', { count: data.today.bills })}
              </span>
            </TodayCard>
            {can('cost.view') ? (
              <TodayCard label={t('home.profit_today')} testId="today-profit">
                <MoneyText paisa={data.today.grossProfit} />
              </TodayCard>
            ) : null}
            {can('dayclose.view_expected') ? (
              <TodayCard label={t('home.cash_drawer')} testId="today-cash">
                <MoneyText paisa={data.cash} />
              </TodayCard>
            ) : null}
            <TodayCard label={t('home.udhaar_today')} testId="today-udhaar">
              <span className="block text-body">
                {t('home.udhaar_given', {
                  amount: formatMoney(data.today.udhaarGiven),
                })}
              </span>
              <span className="block text-body">
                {t('home.udhaar_received', {
                  amount: formatMoney(data.today.udhaarReceived),
                })}
              </span>
            </TodayCard>
          </ul>
          {online ? null : (
            <p className="mt-2 text-small text-text-muted">
              {t('home.as_of_device')}
            </p>
          )}
        </section>
      ) : null}

      <section aria-labelledby="quick-heading">
        <h2 id="quick-heading" className="mb-2 text-h2 font-semibold">
          {t('home.quick_actions')}
        </h2>
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {tiles.map((tile) => (
            <li key={tile.to + tile.label}>
              <Link
                to={tile.to}
                className="flex min-h-20 flex-col items-center justify-center gap-1 rounded-card border border-border bg-surface p-2 text-center"
              >
                <span className="font-medium">{t(tile.label)}</span>
                <KeyBadge keys={tile.keys} />
              </Link>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => openPriceCheck(true)}
              className="flex min-h-20 w-full flex-col items-center justify-center gap-1 rounded-card border border-border bg-surface p-2 text-center"
            >
              <span className="font-medium">{t('home.price_check')}</span>
              <KeyBadge keys="Alt+P" />
            </button>
          </li>
        </ul>
      </section>

      {data && data.attention.length > 0 ? (
        <section aria-labelledby="attention-heading">
          <h2 id="attention-heading" className="mb-2 text-h2 font-semibold">
            {t('home.attention')}
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
            {data.attention.map((item) => (
              <li key={item.kind}>
                <Link
                  to={ATTENTION_LINK[item.kind] ?? '/'}
                  className={`flex min-h-11 items-center px-3 py-2 ${attentionTone(item)}`}
                  data-testid={`attn-${item.kind}`}
                >
                  {attentionText(t, i18n.language, item)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="mb-2 text-h2 font-semibold">
          {t('home.recent_bills')}
        </h2>
        {data && data.recent.length === 0 ? (
          <p className="text-text-muted">{t('home.no_bills')}</p>
        ) : null}
        {data && data.recent.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
            {data.recent.map(({ sale, methods }) => (
              <li key={sale.id}>
                <Link
                  to="/sales/$id"
                  params={{ id: sale.id }}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                >
                  <bdi dir="ltr" className="font-mono">
                    {String(sale.invoice_no)}
                  </bdi>
                  <bdi dir="ltr" className="text-small text-text-muted">
                    {timeFmt.format(Number(sale.created_at))}
                  </bdi>
                  <span className="flex gap-1">
                    {methods.map((m) => (
                      <span
                        key={m}
                        className="rounded-full bg-surface-2 px-2 text-small"
                      >
                        {t(`payment.${m}`)}
                      </span>
                    ))}
                  </span>
                  <span className="ms-auto">
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
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <li
      className="rounded-card border border-border bg-surface p-4"
      data-testid={testId}
    >
      <p className="text-small text-text-muted">{label}</p>
      <p className="mt-1 text-h2 font-semibold">{children}</p>
    </li>
  );
}
