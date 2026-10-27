import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { adminErrorMessage, getTenant, setMaintenance } from './api.ts';
import { DeleteTab } from './DeleteTab.tsx';
import { DevicesTab } from './DevicesTab.tsx';
import { ExportTab } from './ExportTab.tsx';
import { adminHref, statusLabelKey, tenantBandColor } from './format.ts';
import { PinTab } from './PinTab.tsx';
import { RestoreTab } from './RestoreTab.tsx';
import {
  clearRestoreState,
  type RestoreState,
  readRestoreState,
} from './restore.ts';
import { SummaryTab } from './SummaryTab.tsx';
import { AdminConfirm, primaryBtn, quietBtn } from './ui.tsx';
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
  const { t } = useTranslation();
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

  return (
    <div className="flex flex-col gap-4">
      <p>
        <a
          href={adminHref('/admin/tenants')}
          className="text-primary underline"
        >
          {t('admin.back_to_shops')}
        </a>
      </p>
      <header
        className="rounded-card px-4 py-3 text-white"
        style={{ background: tenantBandColor(tenant.id) }}
      >
        <h1 className="text-title font-semibold">{tenant.display_name}</h1>
        <p className="font-mono">{tenant.slug}</p>
        <p className="text-small">{t(statusLabelKey(tenant.status))}</p>
      </header>
      {maintenance ? (
        <div
          className="flex flex-col gap-2 rounded-card bg-warning-subtle p-4 text-warning-subtle-ink"
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
        className="flex flex-wrap gap-1"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className="inline-flex min-h-11 items-center rounded-control px-3 aria-selected:bg-primary-subtle aria-selected:text-primary-subtle-ink"
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
