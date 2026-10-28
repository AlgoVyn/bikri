import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import {
  AdminApiError,
  adminErrorMessage,
  deleteTenant,
  getTenant,
} from './api.ts';
import { adminHref, formatWhen, statusLabelKey } from './format.ts';
import type { Tenant } from './types.ts';
import { dangerBtn, Panel, quietBtn, ReasonDialog } from './ui.tsx';

export function DeleteTab({
  tenant,
  onChanged,
  onExport,
}: {
  tenant: Tenant;
  onChanged: () => void;
  onExport: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const lang = i18n.language;
  const deleting = tenant.status === 'deleting';

  useEffect(() => {
    if (!deleting) return;
    let stop = false;
    let timer = 0;
    const tick = () => {
      if (stop) return;
      void getTenant(tenant.id)
        .then((detail) => {
          if (stop) return;
          if (detail.tenant.status === 'deleted') {
            window.location.assign(adminHref('/admin/tenants'));
            return;
          }
          timer = window.setTimeout(tick, 5000);
        })
        .catch((err: unknown) => {
          if (stop) return;
          if (err instanceof AdminApiError && err.status === 404) {
            window.location.assign(adminHref('/admin/tenants'));
            return;
          }
          timer = window.setTimeout(tick, 5000);
        });
    };
    timer = window.setTimeout(tick, 5000);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [deleting, tenant.id]);

  return (
    <>
      <Panel
        title={t('admin.delete_zone')}
        description={t('admin.delete_zone_hint')}
        className="max-w-2xl border-danger/30"
      >
        <div className="flex flex-col gap-4">
          <p className="rounded-control border border-danger-subtle bg-danger-subtle px-3 py-2 text-small text-danger-subtle-ink">
            {t('admin.delete_warning')}
          </p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-small text-text-muted">
                {t('admin.last_export')}
              </dt>
              <dd className="font-medium tabular-nums">
                {tenant.last_owner_export_at === null
                  ? t('admin.never')
                  : formatWhen(tenant.last_owner_export_at, lang)}
              </dd>
            </div>
            <div>
              <dt className="text-small text-text-muted">
                {t('admin.col_status')}
              </dt>
              <dd className="font-medium">
                {t(statusLabelKey(tenant.status))}
              </dd>
            </div>
          </dl>
          <p className="text-small text-text-muted">
            {t('admin.delete_offer')}
          </p>
          {deleting ? (
            <p
              className="rounded-control bg-warning-subtle px-3 py-2 text-small text-warning-subtle-ink"
              role="status"
            >
              {t('admin.delete_progress')}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <button type="button" className={quietBtn} onClick={onExport}>
              {t('admin.tab_export')}
            </button>
            {tenant.status !== 'deleted' && !deleting ? (
              <button
                type="button"
                className={dangerBtn}
                onClick={() => setOpen(true)}
              >
                {t('admin.delete_go')}
              </button>
            ) : null}
          </div>
        </div>
      </Panel>
      <ReasonDialog
        open={open}
        title={t('admin.delete')}
        body={t('admin.delete_warning')}
        confirmLabel={t('admin.delete_go')}
        danger
        slug={tenant.slug}
        pending={pending}
        onOpenChange={setOpen}
        onConfirm={async ({ reason, slug }) => {
          setPending(true);
          try {
            await deleteTenant(tenant.id, slug, reason);
            toast.push(t('admin.delete_progress'), 'info');
            onChanged();
            return true;
          } catch (err: unknown) {
            toast.push(adminErrorMessage(err, t('admin.err_generic')), 'error');
            return false;
          } finally {
            setPending(false);
          }
        }}
      />
    </>
  );
}
