import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import {
  AdminApiError,
  adminErrorMessage,
  deleteTenant,
  getTenant,
} from './api.ts';
import { adminHref, formatWhen } from './format.ts';
import type { Tenant } from './types.ts';
import { dangerBtn, quietBtn, ReasonDialog } from './ui.tsx';

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
    <div className="flex max-w-xl flex-col gap-3">
      <p>{t('admin.delete_warning')}</p>
      <p>
        {t('admin.delete_last_export', {
          when:
            tenant.last_owner_export_at === null
              ? t('admin.never')
              : formatWhen(tenant.last_owner_export_at, lang),
        })}
      </p>
      <p>{t('admin.delete_offer')}</p>
      <button type="button" className={quietBtn} onClick={onExport}>
        {t('admin.tab_export')}
      </button>
      {deleting ? <p role="status">{t('admin.delete_progress')}</p> : null}
      {tenant.status !== 'deleted' && !deleting ? (
        <button
          type="button"
          className={dangerBtn}
          onClick={() => setOpen(true)}
        >
          {t('admin.delete_go')}
        </button>
      ) : null}
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
    </div>
  );
}
