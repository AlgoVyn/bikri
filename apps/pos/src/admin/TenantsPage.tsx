import { useTranslation } from 'react-i18next';
import { listTenants } from './api.ts';
import {
  adminHref,
  formatCount,
  formatWhen,
  statusLabelKey,
} from './format.ts';
import { primaryBtn } from './ui.tsx';
import { useAdminQuery } from './useAdminQuery.ts';

export function TenantsPage() {
  const { t, i18n } = useTranslation();
  const query = useAdminQuery('tenants', listTenants);
  const lang = i18n.language;
  if (query.data === null) {
    return query.error !== null ? (
      <p className="text-text-muted">
        {query.error}{' '}
        <button type="button" className={primaryBtn} onClick={query.reload}>
          {t('admin.retry')}
        </button>
      </p>
    ) : (
      <p className="sr-only">{t('common.loading')}</p>
    );
  }
  const tenants = query.data.tenants;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-title font-semibold">{t('admin.tenants_title')}</h1>
        <a href={adminHref('/admin/tenants/new')} className={primaryBtn}>
          {t('admin.new_shop')}
        </a>
      </div>
      {tenants.length === 0 ? (
        <p className="text-text-muted">{t('admin.empty_tenants')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full text-left text-small">
            <thead className="border-b border-border text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t('admin.col_name')}</th>
                <th className="px-3 py-2 font-medium">{t('admin.col_slug')}</th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_status')}
                </th>
                <th className="px-3 py-2 text-end font-medium">
                  {t('admin.col_devices')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_last_seen')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_setup')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t('admin.col_writes')}
                </th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => {
                const hot =
                  tenant.daily_write_budget > 0 &&
                  tenant.today.rows_written >= tenant.daily_write_budget;
                const warn =
                  !hot &&
                  tenant.daily_write_budget > 0 &&
                  tenant.today.rows_written >= 0.8 * tenant.daily_write_budget;
                let tone = 'var(--color-primary)';
                if (warn) tone = 'var(--color-warning)';
                if (hot) tone = 'var(--color-danger)';
                const limit =
                  tenant.daily_write_budget > 0 ? tenant.daily_write_budget : 1;
                return (
                  <tr key={tenant.id} className="border-b border-border">
                    <td className="px-3 py-2">
                      <a
                        href={adminHref(`/admin/tenants/${tenant.id}`)}
                        className="font-medium text-primary underline"
                      >
                        {tenant.display_name}
                      </a>
                    </td>
                    <td className="px-3 py-2 font-mono">{tenant.slug}</td>
                    <td className="px-3 py-2">
                      {t(statusLabelKey(tenant.status))}
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums">
                      {formatCount(tenant.devices, lang)}
                    </td>
                    <td className="px-3 py-2">
                      {tenant.last_seen_at === null
                        ? t('admin.never')
                        : formatWhen(tenant.last_seen_at, lang)}
                    </td>
                    <td className="px-3 py-2">
                      {tenant.setup_completed
                        ? t('admin.setup_done')
                        : t('admin.setup_pending')}
                    </td>
                    <td className="px-3 py-2">
                      <meter
                        className="h-2 w-36"
                        min={0}
                        max={limit}
                        value={tenant.today.rows_written}
                        style={{ accentColor: tone }}
                        aria-label={t('admin.writes_bar', {
                          written: formatCount(tenant.today.rows_written, lang),
                          budget: formatCount(tenant.daily_write_budget, lang),
                        })}
                      />
                      <p className="mt-1 tabular-nums text-text-muted">
                        {t('admin.writes_bar', {
                          written: formatCount(tenant.today.rows_written, lang),
                          budget: formatCount(tenant.daily_write_budget, lang),
                        })}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
