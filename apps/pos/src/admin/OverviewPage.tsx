import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import {
  AdminApiError,
  adminErrorMessage,
  getTenant,
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
  statusLabelKey,
} from './format.ts';
import type { TenantListItem, UsageOverview } from './types.ts';
import { Meter } from './ui.tsx';

type ConflictRow = { id: string; name: string; count: number };

export function OverviewPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [usage, setUsage] = useState<UsageOverview | null>(null);
  const [tenants, setTenants] = useState<TenantListItem[]>([]);
  const [conflicts, setConflicts] = useState<ConflictRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getUsage(), listTenants()])
      .then(async ([nextUsage, list]) => {
        if (cancelled) return;
        setUsage(nextUsage);
        setTenants(list.tenants);
        const rows = await Promise.all(
          list.tenants.map(async (tenant) => {
            try {
              const detail = await getTenant(tenant.id);
              return {
                id: tenant.id,
                name: tenant.display_name,
                count: detail.open_conflicts,
              };
            } catch {
              return { id: tenant.id, name: tenant.display_name, count: 0 };
            }
          }),
        );
        if (!cancelled) setConflicts(rows.filter((row) => row.count > 0));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
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
  }, [t, toast]);

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
  const open = conflicts?.filter((row) => row.count > 0) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title font-semibold">{t('admin.overview_title')}</h1>
      <p>{t('admin.signed_in', { email: usage.email })}</p>
      <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <h2 className="font-semibold">{t('admin.d1_size')}</h2>
        <p className="tabular-nums">
          {usage.db_size_bytes === null
            ? t('admin.never')
            : t('admin.d1_of', {
                size: formatBytes(usage.db_size_bytes, lang),
                limit: formatBytes(D1_LIMIT_BYTES, lang),
              })}
        </p>
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
          {t('admin.share_70', { value: formatCount(writeShare, lang) })}
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
          {t('admin.share_70', { value: formatCount(readShare, lang) })}
        </p>
      </section>
      <section className="rounded-card border border-border bg-surface p-4">
        <h2 className="font-semibold">{t('admin.last_backup')}</h2>
        {backup === null ? (
          <p>{t('admin.backup_never')}</p>
        ) : (
          <p className={stale ? 'text-danger' : undefined}>
            {formatWhen(backup.uploaded, lang)} ·{' '}
            {formatBytes(backup.size, lang)}
            {stale ? ` — ${t('admin.backup_old')}` : ''}
          </p>
        )}
      </section>
      <section className="rounded-card border border-border bg-surface p-4">
        <h2 className="font-semibold">{t('admin.by_status')}</h2>
        <ul className="mt-2 flex flex-col gap-1">
          {knownStatuses().map((status) => (
            <li key={status} className="flex justify-between gap-3">
              <span>{t(statusLabelKey(status))}</span>
              <span className="tabular-nums">
                {formatCount(usage.tenants_by_status[status] ?? 0, lang)}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="rounded-card border border-border bg-surface p-4">
        <h2 className="font-semibold">{t('admin.over_80')}</h2>
        {usage.over_80.length === 0 ? (
          <p className="text-text-muted">{t('admin.over_80_none')}</p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {usage.over_80.map((id) => {
              const tenant = byId.get(id);
              const name = tenant?.display_name ?? id;
              return (
                <li key={id}>
                  <a
                    href={adminHref(`/admin/tenants/${id}`)}
                    className="inline-flex min-h-11 items-center text-primary underline"
                  >
                    {name}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="rounded-card border border-border bg-surface p-4">
        <h2 className="font-semibold">{t('admin.conflicts')}</h2>
        {conflicts === null ? (
          <p className="text-text-muted">{t('common.loading')}</p>
        ) : open.length === 0 ? (
          <p className="text-text-muted">{t('admin.conflicts_none')}</p>
        ) : (
          <ul className="mt-2 flex flex-col">
            {open.map((row) => (
              <li key={row.id}>
                <a
                  href={adminHref(`/admin/tenants/${row.id}`)}
                  className="inline-flex min-h-11 items-center text-primary underline"
                >
                  {t('admin.conflicts_row', {
                    name: row.name,
                    count: formatCount(row.count, lang),
                  })}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
