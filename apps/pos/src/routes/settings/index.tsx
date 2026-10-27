import { createFileRoute, Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonDanger } from '../../components/classes.ts';
import { getDb } from '../../data/db.ts';
import { deviceInfo, tenantInfo } from '../../data/localTenant.ts';
import { useCurrentStaff } from '../../state/currentStaff.ts';

export const Route = createFileRoute('/settings/')({
  component: SettingsPage,
});

const rowLink = 'flex min-h-14 flex-col justify-center p-3';

/** Settings (screens/17): printer, sync, devices (admin device + owner) and this device. */
function SettingsPage() {
  const { t } = useTranslation();
  const { role } = useCurrentStaff();
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const info = useLiveQuery(async () => {
    const db = getDb();
    return {
      device: await deviceInfo(db),
      tenant: await tenantInfo(db),
      enrolled: Boolean((await db.kv.get('device_token'))?.value),
    };
  }, []);
  const owner = role === 'owner';
  const leave = async () => {
    setLeaveError(null);
    if (
      !window.confirm(
        t('enrol.leave_confirm', { shop: info?.tenant?.display_name ?? '' }),
      )
    )
      return;
    const db = getDb();
    const { leaveShop, UnsyncedOpsError } = await import('../../data/enrol.ts');
    try {
      await leaveShop(db);
      window.location.assign(`${import.meta.env.BASE_URL || '/'}enrol`);
    } catch (e) {
      setLeaveError(
        e instanceof UnsyncedOpsError
          ? t('enrol.leave_blocked', { count: e.count })
          : String(e),
      );
    }
  };
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-h1 font-semibold">{t('nav.settings')}</h1>
      <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
        <li>
          <Link to="/settings/printer" className={rowLink}>
            <span className="font-medium">{t('printer.title')}</span>
            <span className="text-small text-text-muted">
              {t('settings.printer_hint')}
            </span>
          </Link>
        </li>
        <li>
          <Link to="/settings/sync" className={rowLink}>
            <span className="font-medium">{t('syncpage.title')}</span>
            <span className="text-small text-text-muted">
              {t('settings.sync_hint')}
            </span>
          </Link>
        </li>
        {owner && info?.device?.is_admin && info.enrolled ? (
          <li>
            <Link to="/settings/devices" className={rowLink}>
              <span className="font-medium">{t('devices.title')}</span>
              <span className="text-small text-text-muted">
                {t('settings.devices_hint')}
              </span>
            </Link>
          </li>
        ) : null}
      </ul>
      {info?.device ? (
        <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
          <h2 className="font-medium">{t('settings.this_device')}</h2>
          <p className="text-small text-text-muted" data-testid="this-device">
            {info.tenant?.display_name ?? ''} · {info.device.name} ·{' '}
            {info.device.code} ·{' '}
            {info.device.is_admin
              ? t('settings.admin_device')
              : t('settings.till_device')}
          </p>
          {owner && info.enrolled ? (
            <>
              <p className="text-small">{t('settings.leave_hint')}</p>
              <button
                type="button"
                className={`${buttonDanger} self-start`}
                onClick={() => void leave()}
              >
                {t('settings.leave')}
              </button>
              {leaveError ? (
                <p role="alert" className="text-danger text-small">
                  {leaveError}
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
