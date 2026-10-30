import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchIcon, StoreIcon } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { listTenants } from './api.ts';
import {
  adminHref,
  formatCount,
  formatWhen,
  knownStatuses,
  statusLabelKey,
} from './format.ts';
import type { TenantListItem } from './types.ts';
import { Panel, primaryBtn, quietBtn, StatusBadge } from './ui.tsx';
import { useAdminQuery } from './useAdminQuery.ts';

const PAGE_SIZE = 20;

export function TenantsPage() {
  const { t, i18n } = useTranslation();
  const query = useAdminQuery('tenants', listTenants);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
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
  const needle = search.trim().toLowerCase();
  const filtered = tenants.filter((tenant) => {
    if (status !== '' && tenant.status !== status) return false;
    if (needle === '') return true;
    return (
      tenant.display_name.toLowerCase().includes(needle) ||
      tenant.slug.toLowerCase().includes(needle)
    );
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const filtering = needle !== '' || status !== '';
  const clear = () => {
    setSearch('');
    setStatus('');
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<StoreIcon />}
        title={t('admin.tenants_title')}
        subtitle={t('admin.tenants_subtitle')}
        actions={
          <a href={adminHref('/admin/tenants/new')} className={primaryBtn}>
            {t('admin.new_shop')}
          </a>
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-card border border-border bg-surface p-3 shadow-card">
        <label className="flex min-w-56 flex-1 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 focus-within:border-primary">
          <SearchIcon />
          <span className="sr-only">{t('admin.search_shops')}</span>
          <input
            type="search"
            className="h-11 min-w-0 flex-1 bg-transparent text-text outline-none"
            placeholder={t('admin.search_shops_placeholder')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="flex items-center gap-2 text-small">
          <span className="text-text-muted">{t('admin.filter_status')}</span>
          <select
            className="h-11 rounded-control border border-border-strong bg-surface px-2 text-text"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('admin.all_statuses')}</option>
            {knownStatuses().map((item) => (
              <option key={item} value={item}>
                {t(statusLabelKey(item))}
              </option>
            ))}
          </select>
        </label>
        {filtering ? (
          <button type="button" className={quietBtn} onClick={clear}>
            {t('admin.clear_filters')}
          </button>
        ) : null}
        <p className="ms-auto self-center text-small text-text-muted tabular-nums">
          {t('admin.shops_count', {
            count: formatCount(filtered.length, lang),
          })}
        </p>
      </div>

      {tenants.length === 0 ? (
        <Panel bodyClassName="flex flex-col items-center gap-3 px-4 py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-text-muted">
            <StoreIcon />
          </span>
          <p className="font-medium">{t('admin.empty_tenants')}</p>
          <a href={adminHref('/admin/tenants/new')} className={primaryBtn}>
            {t('admin.new_shop')}
          </a>
        </Panel>
      ) : filtered.length === 0 ? (
        <Panel bodyClassName="flex flex-col items-center gap-3 px-4 py-14 text-center">
          <p className="font-medium">{t('admin.no_match')}</p>
          <button type="button" className={quietBtn} onClick={clear}>
            {t('admin.clear_filters')}
          </button>
        </Panel>
      ) : (
        <Panel bodyClassName="p-0">
          <ul className="flex flex-col divide-y divide-border md:hidden">
            {shown.map((tenant) => (
              <li key={tenant.id}>
                <a
                  href={adminHref(`/admin/tenants/${tenant.id}`)}
                  className="flex flex-col gap-2 p-4 hover:bg-surface-2/60"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {tenant.display_name}
                      </p>
                      <p className="truncate font-mono text-small text-text-muted">
                        {tenant.slug}
                      </p>
                    </div>
                    <StatusBadge status={tenant.status} />
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-small text-text-muted">
                    <span>
                      {tenant.devices} {t('admin.col_devices')}
                    </span>
                    <span>
                      {tenant.last_seen_at === null
                        ? t('admin.never')
                        : formatWhen(tenant.last_seen_at, lang)}
                    </span>
                    <span>
                      {tenant.setup_completed
                        ? t('admin.setup_done')
                        : t('admin.setup_pending')}
                    </span>
                  </div>
                  <WriteMeter tenant={tenant} lang={lang} />
                </a>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[880px] text-start text-small">
              <caption className="sr-only">{t('admin.tenants_title')}</caption>
              <thead className="border-b border-border bg-surface-2 text-text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 text-start font-medium">
                    {t('admin.col_name')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-start font-medium">
                    {t('admin.col_status')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-end font-medium">
                    {t('admin.col_devices')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-start font-medium">
                    {t('admin.col_last_seen')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-start font-medium">
                    {t('admin.col_setup')}
                  </th>
                  <th scope="col" className="px-4 py-3 text-start font-medium">
                    {t('admin.col_writes')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((tenant) => {
                  return (
                    <tr
                      key={tenant.id}
                      className="border-b border-border last:border-b-0 hover:bg-surface-2/60"
                    >
                      <td className="px-4 py-3">
                        <a
                          href={adminHref(`/admin/tenants/${tenant.id}`)}
                          className="group inline-flex min-w-0 flex-col"
                        >
                          <span className="truncate font-medium text-text group-hover:text-primary">
                            {tenant.display_name}
                          </span>
                          <span className="font-mono text-small text-text-muted">
                            {tenant.slug}
                          </span>
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={tenant.status} />
                      </td>
                      <td className="px-4 py-3 text-end tabular-nums">
                        {formatCount(tenant.devices, lang)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {tenant.last_seen_at === null
                          ? t('admin.never')
                          : formatWhen(tenant.last_seen_at, lang)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 ${
                            tenant.setup_completed
                              ? 'text-success-subtle-ink'
                              : 'text-text-muted'
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`size-1.5 rounded-full ${
                              tenant.setup_completed
                                ? 'bg-success'
                                : 'bg-border-strong'
                            }`}
                          />
                          {tenant.setup_completed
                            ? t('admin.setup_done')
                            : t('admin.setup_pending')}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <WriteMeter tenant={tenant} lang={lang} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
            <p className="text-small text-text-muted tabular-nums">
              {t('admin.page_of', {
                page: formatCount(current, lang),
                pages: formatCount(pages, lang),
              })}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className={quietBtn}
                disabled={current <= 1}
                onClick={() => setPage(current - 1)}
              >
                {t('admin.prev')}
              </button>
              <button
                type="button"
                className={quietBtn}
                disabled={current >= pages}
                onClick={() => setPage(current + 1)}
              >
                {t('admin.next')}
              </button>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

function WriteMeter({
  tenant,
  lang,
}: {
  tenant: TenantListItem;
  lang: string;
}) {
  const { t } = useTranslation();
  const budget = tenant.daily_write_budget;
  const hot = budget > 0 && tenant.today.rows_written >= budget;
  const warn = !hot && budget > 0 && tenant.today.rows_written >= 0.8 * budget;
  let tone = 'var(--color-primary)';
  if (warn) tone = 'var(--color-warning)';
  if (hot) tone = 'var(--color-danger)';
  return (
    <div>
      <meter
        className="h-2 w-full max-w-28"
        min={0}
        max={budget > 0 ? budget : 1}
        value={tenant.today.rows_written}
        style={{ accentColor: tone }}
        aria-label={t('admin.writes_bar', {
          written: formatCount(tenant.today.rows_written, lang),
          budget: formatCount(budget, lang),
        })}
      />
      <p className="mt-1 text-small text-text-muted tabular-nums">
        {t('admin.writes_bar', {
          written: formatCount(tenant.today.rows_written, lang),
          budget: formatCount(budget, lang),
        })}
      </p>
    </div>
  );
}
