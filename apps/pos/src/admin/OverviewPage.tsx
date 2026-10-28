import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudIcon, ReportsIcon } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  AdminApiError,
  adminErrorMessage,
  getUsage,
  listTenants,
} from './api.ts';
import {
  adminHref,
  BACKUP_STALE_MS,
  D1_LIMIT_BYTES,
  FREE_READS_PER_DAY,
  FREE_WRITES_PER_DAY,
  formatBytes,
  formatCount,
  formatWhen,
  knownStatuses,
  SHOP_SHARE,
} from './format.ts';
import type { TenantListItem, UsageOverview } from './types.ts';
import { Meter, Panel, quietBtn, StatCard, StatusBadge } from './ui.tsx';

export function OverviewPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [usage, setUsage] = useState<UsageOverview | null>(null);
  const [tenants, setTenants] = useState<TenantListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const request = tick;
    setError(null);
    void Promise.all([getUsage(), listTenants()])
      .then(async ([nextUsage, list]) => {
        if (cancelled || request !== tick) return;
        setUsage(nextUsage);
        setTenants(list.tenants);
      })
      .catch((err: unknown) => {
        if (cancelled || request !== tick) return;
        const message =
          err instanceof AdminApiError && err.status === 403
            ? t('admin.err_not_operator')
            : adminErrorMessage(err, t('admin.err_generic'));
        setError(message);
        toast.push(message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast, tick]);

  if (error !== null && usage === null) {
    return <p className="text-text-muted">{error}</p>;
  }
  if (usage === null) {
    return <p className="sr-only">{t('common.loading')}</p>;
  }
  const lang = i18n.language;
  const writeShare = Math.round(FREE_WRITES_PER_DAY * SHOP_SHARE);
  const readShare = Math.round(FREE_READS_PER_DAY * SHOP_SHARE);
  const backup = usage.last_backup;
  const stale =
    backup !== null && Date.now() - backup.uploaded > BACKUP_STALE_MS;
  const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  const open = usage.open_conflicts.map((row) => ({
    id: row.tenant_id,
    name: byId.get(row.tenant_id)?.display_name ?? row.tenant_id,
    count: row.count,
  }));
  const active = usage.tenants_by_status.active ?? 0;
  const devices = tenants.reduce((sum, tenant) => sum + tenant.devices, 0);
  const setup = tenants.filter((tenant) => tenant.setup_completed).length;
  const conflictTotal = open.reduce((sum, row) => sum + row.count, 0);
  const backupOk = backup !== null && !stale;
  const quiet = open.length === 0 && usage.over_80.length === 0 && backupOk;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={<ReportsIcon />}
        title={t('admin.overview_title')}
        subtitle={t('admin.overview_subtitle')}
        actions={
          <>
            <span className="inline-flex min-h-9 items-center rounded-full bg-surface-2 px-3 text-small text-text-muted">
              {t('admin.signed_in', { email: usage.email })}
            </span>
            <button
              type="button"
              className={quietBtn}
              onClick={() => setTick((value) => value + 1)}
            >
              {t('admin.refresh')}
            </button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label={t('admin.stat_shops')}
          value={formatCount(tenants.length, lang)}
        />
        <StatCard
          label={t('admin.stat_active')}
          value={formatCount(active, lang)}
        />
        <StatCard
          label={t('admin.stat_devices')}
          value={formatCount(devices, lang)}
        />
        <StatCard
          label={t('admin.stat_setup')}
          value={formatCount(setup, lang)}
          hint={t('admin.stat_setup_hint', {
            done: formatCount(setup, lang),
            total: formatCount(tenants.length, lang),
          })}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] xl:items-start">
        <div className="flex flex-col gap-4">
          <Panel
            title={t('admin.usage_today')}
            description={t('admin.usage_today_hint')}
          >
            <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border pb-3">
              <div>
                <p className="text-small text-text-muted">
                  {t('admin.d1_size')}
                </p>
                <p className="text-title font-semibold tabular-nums">
                  {usage.db_size_bytes === null
                    ? t('admin.never')
                    : formatBytes(usage.db_size_bytes, lang)}
                </p>
              </div>
              <p className="text-small text-text-muted tabular-nums">
                {t('admin.d1_limit', {
                  limit: formatBytes(D1_LIMIT_BYTES, lang),
                })}
              </p>
            </div>
            <div className="mt-4 flex flex-col gap-4">
              <Meter
                label={t('admin.writes_today')}
                value={usage.today.rows_written}
                max={FREE_WRITES_PER_DAY}
                warnAt={writeShare}
                valueText={t('admin.of_limit', {
                  value: formatCount(usage.today.rows_written, lang),
                  limit: formatCount(FREE_WRITES_PER_DAY, lang),
                })}
              />
              <p className="text-small text-text-muted">
                {t('admin.share_70', {
                  value: formatCount(writeShare, lang),
                })}
              </p>
              <Meter
                label={t('admin.reads_today')}
                value={usage.today.rows_read}
                max={FREE_READS_PER_DAY}
                warnAt={readShare}
                valueText={t('admin.of_limit', {
                  value: formatCount(usage.today.rows_read, lang),
                  limit: formatCount(FREE_READS_PER_DAY, lang),
                })}
              />
              <p className="text-small text-text-muted">
                {t('admin.share_70', {
                  value: formatCount(readShare, lang),
                })}
              </p>
            </div>
          </Panel>

          <Panel
            title={t('admin.by_status')}
            description={t('admin.by_status_hint')}
          >
            <ul className="grid gap-2 sm:grid-cols-2">
              {knownStatuses().map((status) => (
                <li
                  key={status}
                  className="flex items-center justify-between gap-3 rounded-control bg-surface-2/60 px-3 py-2"
                >
                  <StatusBadge status={status} />
                  <span className="font-semibold tabular-nums">
                    {formatCount(usage.tenants_by_status[status] ?? 0, lang)}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <Panel
          title={t('admin.needs_attention')}
          description={t('admin.needs_attention_hint')}
        >
          <div className="flex flex-col divide-y divide-border">
            <section
              className="flex items-start gap-3 pb-4"
              aria-labelledby="backup-row"
            >
              <span
                aria-hidden="true"
                className={`flex size-10 shrink-0 items-center justify-center rounded-control ${
                  backup === null || stale
                    ? 'bg-warning-subtle text-warning-subtle-ink'
                    : 'bg-success-subtle text-success-subtle-ink'
                }`}
              >
                <CloudIcon />
              </span>
              <div className="min-w-0 flex-1">
                <h3 id="backup-row" className="text-small font-medium">
                  {t('admin.last_backup')}
                </h3>
                {backup === null ? (
                  <p className="text-small text-text-muted">
                    {t('admin.backup_never')}
                  </p>
                ) : (
                  <p className="text-small text-text-muted tabular-nums">
                    {formatWhen(backup.uploaded, lang)} ·{' '}
                    {formatBytes(backup.size, lang)}
                  </p>
                )}
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-small font-medium ${
                  backup === null || stale
                    ? 'bg-warning-subtle text-warning-subtle-ink'
                    : 'bg-success-subtle text-success-subtle-ink'
                }`}
              >
                {backup === null
                  ? t('admin.never')
                  : stale
                    ? t('admin.backup_old')
                    : t('admin.backup_ok')}
              </span>
            </section>

            <section className="py-4" aria-labelledby="over-budget-row">
              <div className="flex items-center justify-between gap-3">
                <h3 id="over-budget-row" className="text-small font-medium">
                  {t('admin.over_80')}
                </h3>
                <span
                  className={`rounded-full px-2 py-0.5 text-small font-semibold tabular-nums ${
                    usage.over_80.length === 0
                      ? 'bg-surface-2 text-text-muted'
                      : 'bg-warning-subtle text-warning-subtle-ink'
                  }`}
                >
                  {formatCount(usage.over_80.length, lang)}
                </span>
              </div>
              <p className="mt-0.5 text-small text-text-muted">
                {t('admin.over_80_hint')}
              </p>
              {usage.over_80.length === 0 ? (
                <p className="mt-2 text-small text-text-muted">
                  {t('admin.over_80_none')}
                </p>
              ) : (
                <ul className="mt-1 flex flex-col">
                  {usage.over_80.map((id) => {
                    const tenant = byId.get(id);
                    return (
                      <li key={id}>
                        <a
                          href={adminHref(`/admin/tenants/${id}`)}
                          className="flex min-h-9 items-center justify-between gap-2 rounded-control px-1 text-small font-medium text-primary hover:bg-surface-2"
                        >
                          <span className="truncate">
                            {tenant?.display_name ?? id}
                          </span>
                          <span aria-hidden="true" className="rtl:rotate-180">
                            ›
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="pt-4" aria-labelledby="conflicts-row">
              <div className="flex items-center justify-between gap-3">
                <h3 id="conflicts-row" className="text-small font-medium">
                  {t('admin.conflicts')}
                </h3>
                <span
                  className={`rounded-full px-2 py-0.5 text-small font-semibold tabular-nums ${
                    conflictTotal === 0
                      ? 'bg-success-subtle text-success-subtle-ink'
                      : 'bg-danger-subtle text-danger-subtle-ink'
                  }`}
                >
                  {formatCount(conflictTotal, lang)}
                </span>
              </div>
              <p className="mt-0.5 text-small text-text-muted">
                {t('admin.conflicts_hint')}
              </p>
              {open.length === 0 ? (
                <p className="mt-2 text-small text-text-muted">
                  {t('admin.conflicts_none')}
                </p>
              ) : (
                <ul className="mt-1 flex flex-col">
                  {open.map((row) => (
                    <li key={row.id}>
                      <a
                        href={adminHref(`/admin/tenants/${row.id}`)}
                        className="flex min-h-9 items-center justify-between gap-2 rounded-control px-1 text-small font-medium text-primary hover:bg-surface-2"
                      >
                        <span className="truncate">{row.name}</span>
                        <span className="shrink-0 tabular-nums text-text-muted">
                          {formatCount(row.count, lang)}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {quiet ? (
              <p className="flex items-center gap-2 pt-4 text-small font-medium text-success-subtle-ink">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-success"
                />
                {t('admin.attention_none')}
              </p>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
