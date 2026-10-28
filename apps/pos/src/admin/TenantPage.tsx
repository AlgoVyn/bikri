import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StoreIcon } from '../components/icons.tsx';
import { useToast } from '../components/Toast.tsx';
import { adminErrorMessage, getTenant, setMaintenance } from './api.ts';
import { DeleteTab } from './DeleteTab.tsx';
import { DevicesTab } from './DevicesTab.tsx';
import { ExportTab } from './ExportTab.tsx';
import { adminHref, formatWhen, tenantBandColor } from './format.ts';
import { PinTab } from './PinTab.tsx';
import { RestoreTab } from './RestoreTab.tsx';
import {
  clearRestoreState,
  type RestoreState,
  readRestoreState,
} from './restore.ts';
import { SummaryTab } from './SummaryTab.tsx';
import { AdminConfirm, primaryBtn, quietBtn, StatusBadge } from './ui.tsx';
import { useAdminQuery } from './useAdminQuery.ts';

type Tab = 'summary' | 'devices' | 'pin' | 'export' | 'restore' | 'delete';

const TABS: readonly { id: Tab; key: string }[] = [
  { id: 'summary', key: 'admin.tab_summary' },
  { id: 'devices', key: 'admin.tab_devices' },
  { id: 'pin', key: 'admin.tab_pin' },
  { id: 'export', key: 'admin.tab_export' },
  { id: 'restore', key: 'admin.tab_restore' },
  { id: 'delete', key: 'admin.tab_delete' },
];

export function TenantPage({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const query = useAdminQuery(`tenant:${id}`, () => getTenant(id));
  const [tab, setTab] = useState<Tab>('summary');
  const [stored, setStored] = useState<RestoreState | null>(() =>
    readRestoreState(id, sessionStorage),
  );
  const [offOpen, setOffOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const detail = query.data;

  useEffect(() => {
    if (detail === null) return;
    const previous = document.title;
    document.title = `${detail.tenant.display_name} — ${t('admin.title')}`;
    return () => {
      document.title = previous;
    };
  }, [detail, t]);

  const bump = () => {
    setStored(readRestoreState(id, sessionStorage));
  };

  if (detail === null) {
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

  const tenant = detail.tenant;
  const maintenance = tenant.status === 'maintenance';
  const band = tenantBandColor(tenant.id);
  const lang = i18n.language;

  return (
    <div className="flex flex-col gap-5">
      <a
        href={adminHref('/admin/tenants')}
        className="inline-flex min-h-9 w-fit items-center gap-1 text-small font-medium text-text-muted hover:text-text"
      >
        <span
          aria-hidden="true"
          className="text-title leading-none rtl:rotate-180"
        >
          ‹
        </span>
        {t('admin.back_to_shops')}
      </a>
      <header className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
        <div aria-hidden="true" className="h-1" style={{ background: band }} />
        <div className="flex flex-wrap items-start gap-4 p-4 lg:p-5">
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-control text-white"
            style={{ background: band }}
          >
            <StoreIcon />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-h1 font-semibold">{tenant.display_name}</h1>
              <StatusBadge status={tenant.status} />
            </div>
            <p className="mt-0.5 font-mono text-small text-text-muted">
              {tenant.slug}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small text-text-muted">
              <span>
                {t('admin.owner_email')}:{' '}
                {tenant.owner_email ?? t('admin.never')}
              </span>
              <span>
                {t('admin.devices_count', {
                  count: detail.devices,
                })}
              </span>
              <span>
                {t('admin.created')}: {formatWhen(tenant.created_at, lang)}
              </span>
              <span>
                {t('admin.setup_at')}:{' '}
                {detail.setup_completed_at === null
                  ? t('admin.setup_pending')
                  : formatWhen(detail.setup_completed_at, lang)}
              </span>
            </div>
          </div>
        </div>
      </header>
      {maintenance ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-warning-subtle bg-warning-subtle p-4 text-warning-subtle-ink"
          role="status"
        >
          <p>
            {stored?.aborted
              ? t('admin.aborted_banner')
              : t('admin.maintenance_banner')}
          </p>
          <button
            type="button"
            className={quietBtn}
            onClick={() => setOffOpen(true)}
          >
            {t('admin.end_maintenance')}
          </button>
        </div>
      ) : null}
      <div
        role="tablist"
        aria-label={tenant.display_name}
        className="flex flex-wrap gap-1 rounded-card border border-border bg-surface p-1 shadow-card"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className="inline-flex min-h-11 items-center rounded-control px-3 text-small font-medium text-text-muted hover:bg-surface-2 hover:text-text aria-selected:bg-primary aria-selected:text-primary-ink"
            onClick={() => setTab(item.id)}
          >
            {t(item.key)}
          </button>
        ))}
      </div>
      {tab === 'summary' ? (
        <SummaryTab detail={detail} onChanged={query.reload} />
      ) : null}
      {tab === 'devices' ? (
        <DevicesTab tenantId={tenant.id} shopName={tenant.display_name} />
      ) : null}
      {tab === 'pin' ? <PinTab tenantId={tenant.id} /> : null}
      {tab === 'export' ? <ExportTab tenantId={tenant.id} /> : null}
      {tab === 'restore' ? (
        <RestoreTab
          tenantId={tenant.id}
          onChanged={() => {
            query.reload();
            bump();
          }}
          onState={bump}
        />
      ) : null}
      {tab === 'delete' ? (
        <DeleteTab
          tenant={tenant}
          onChanged={query.reload}
          onExport={() => setTab('export')}
        />
      ) : null}
      <AdminConfirm
        open={offOpen}
        onOpenChange={setOffOpen}
        title={t('admin.end_maintenance')}
        body={t('admin.maintenance_off_body')}
        confirmLabel={t('admin.end_maintenance')}
        onConfirm={() => {
          setPending(true);
          void setMaintenance(
            tenant.id,
            false,
            t('admin.restore_finished_reason'),
          )
            .then(() => {
              clearRestoreState(tenant.id, sessionStorage);
              toast.push(t('admin.maintenance_off_done'), 'info');
              bump();
              query.reload();
            })
            .catch((err: unknown) => {
              toast.push(
                adminErrorMessage(err, t('admin.err_generic')),
                'error',
              );
            })
            .finally(() => {
              setPending(false);
            });
        }}
      />
      {pending ? <p className="sr-only">{t('common.loading')}</p> : null}
    </div>
  );
}
