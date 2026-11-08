import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClockIcon, SearchIcon } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { searchInputClass, searchWrapperClass } from '../components/search.ts';
import { listShopRequests } from './api.ts';
import { adminHref, formatWhen } from './format.ts';
import type { ShopRequest, ShopRequestStatus } from './types.ts';
import { AdminErrorState, Panel } from './ui.tsx';
import { useAdminQuery } from './useAdminQuery.ts';

const STATUSES: ShopRequestStatus[] = [
  'pending',
  'awaiting_email',
  'email_verified',
  'approved',
  'rejected',
  'failed',
];

const TONE: Record<string, string> = {
  pending: 'bg-surface-2 text-text-muted',
  awaiting_email: 'bg-warning-subtle text-warning-subtle-ink',
  email_verified: 'bg-primary-subtle text-primary-subtle-ink',
  approving: 'bg-warning-subtle text-warning-subtle-ink',
  approved: 'bg-success-subtle text-success-subtle-ink',
  rejected: 'bg-danger-subtle text-danger-subtle-ink',
  failed: 'bg-danger-subtle text-danger-subtle-ink',
};

function RequestStatus({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-small font-medium ${TONE[status] ?? TONE.pending}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {t(`admin.request_status_${status}`)}
    </span>
  );
}

function emailState(row: ShopRequest, t: (key: string) => string): string {
  if (row.email_verified_at !== null) return t('admin.request_email_verified');
  if (row.cloudflare_address_id) return t('admin.request_email_sent');
  return t('admin.request_email_not_added');
}

export function RequestsPage() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const query = useAdminQuery(`shop-requests:${status}:${search}`, () =>
    listShopRequests({ status, q: search }),
  );
  if (query.data === null) {
    return query.error !== null ? (
      <AdminErrorState message={query.error} onRetry={query.reload} />
    ) : (
      <p className="sr-only">{t('common.loading')}</p>
    );
  }
  const rows = query.data.requests;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<ClockIcon />}
        title={t('admin.requests_title')}
        subtitle={t('admin.requests_subtitle')}
      />
      <Panel bodyClassName="p-0">
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-3">
          <label className={`${searchWrapperClass} min-w-56 flex-1`}>
            <SearchIcon />
            <span className="sr-only">{t('admin.requests_search')}</span>
            <input
              type="search"
              className={searchInputClass}
              placeholder={t('admin.requests_search_placeholder')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-small">
            <span className="text-text-muted">
              {t('admin.requests_filter_status')}
            </span>
            <select
              className="h-11 rounded-control border border-border-strong bg-surface px-2 text-text"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">{t('admin.requests_all')}</option>
              {STATUSES.map((item) => (
                <option key={item} value={item}>
                  {t(`admin.request_status_${item}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {rows.length === 0 ? (
          <p className="p-6 text-center text-text-muted">
            {t('admin.requests_empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={row.id}>
                <a
                  href={adminHref(`/admin/requests/${row.id}`)}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {row.shop_name}
                    </span>
                    <span className="block truncate text-small text-text-muted">
                      {row.owner_name} · {row.email}
                    </span>
                  </span>
                  <span className="text-small text-text-muted">
                    {emailState(row, t)}
                  </span>
                  <RequestStatus status={row.status} />
                  <span className="w-36 text-end text-small text-text-muted">
                    {formatWhen(row.created_at, i18n.language)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
