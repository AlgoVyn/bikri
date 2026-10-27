import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonDanger } from '../components/classes.ts';
import { getDb } from '../data/db.ts';
import { deviceInfo, tenantInfo } from '../data/localTenant.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

const rowLink = 'flex min-h-14 flex-col justify-center p-3';

/** Settings (screens/17): printer, sync, devices (admin device + owner) and this device. */
export function SettingsHomePage() {
  return (
    <AreaStrings area="office">
      <SettingsHomeContent />
    </AreaStrings>
  );
}

function SettingsHomeContent() {
  const { t } = useTranslation();
  const { role, can } = useCurrentStaff();
  const location = useLocation();
  const navigate = useNavigate();
  const [leaveError, setLeaveError] = useState<string | null>(null);
  useEffect(() => {
    if (location.hash === 'printer')
      void navigate({ to: '/settings/printer', replace: true });
  }, [location.hash, navigate]);
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
    const { leaveShop, UnsyncedOpsError } = await import('../data/enrol.ts');
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
      <nav className="flex flex-col gap-4">
        {can('settings.shop') ? (
          <section>
            <h2 className="mb-1 px-1 text-small text-text-muted">
              {t('office.settings.nav_group_shop')}
            </h2>
            <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
              <li>
                <Link to="/settings/shop" className={rowLink}>
                  <span className="font-medium">
                    {t('office.settings.nav_shop')}
                  </span>
                  <span className="text-small text-text-muted">
                    {t('office.settings.nav_shop_hint')}
                  </span>
                </Link>
              </li>
              {can('settings.staff') ? (
                <li>
                  <Link to="/settings/cashiers" className={rowLink}>
                    <span className="font-medium">
                      {t('office.settings.nav_cashiers')}
                    </span>
                    <span className="text-small text-text-muted">
                      {t('office.settings.nav_cashiers_hint')}
                    </span>
                  </Link>
                </li>
              ) : null}
              <li>
                <Link to="/settings/activity" className={rowLink}>
                  <span className="font-medium">
                    {t('office.settings.nav_activity')}
                  </span>
                  <span className="text-small text-text-muted">
                    {t('office.settings.nav_activity_hint')}
                  </span>
                </Link>
              </li>
            </ul>
          </section>
        ) : null}
        <section>
          <h2 className="mb-1 px-1 text-small text-text-muted">
            {t('office.settings.nav_group_device')}
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
            <li>
              <Link to="/settings/printer" className={rowLink}>
                <span className="font-medium">{t('printer.title')}</span>
                <span className="text-small text-text-muted">
                  {t('office.settings.nav_printer_hint')}
                </span>
              </Link>
            </li>
            {can('catalog.edit') ? (
              <li>
                <Link to="/settings/labels" className={rowLink}>
                  <span className="font-medium">
                    {t('office.settings.nav_labels')}
                  </span>
                  <span className="text-small text-text-muted">
                    {t('office.settings.nav_labels_hint')}
                  </span>
                </Link>
              </li>
            ) : null}
            <li>
              <Link to="/settings/display" className={rowLink}>
                <span className="font-medium">
                  {t('office.settings.nav_display')}
                </span>
                <span className="text-small text-text-muted">
                  {t('office.settings.nav_display_hint')}
                </span>
              </Link>
            </li>
            <li>
              <Link to="/settings/display" className={rowLink}>
                <span className="font-medium">
                  {t('office.settings.nav_language')}
                </span>
                <span className="text-small text-text-muted">
                  {t('office.settings.nav_language_hint')}
                </span>
              </Link>
            </li>
          </ul>
        </section>
        <section>
          <h2 className="mb-1 px-1 text-small text-text-muted">
            {t('office.settings.nav_group_data')}
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
            <li>
              <Link to="/settings/sync" className={rowLink}>
                <span className="font-medium">{t('syncpage.title')}</span>
                <span className="text-small text-text-muted">
                  {t('office.settings.nav_sync_hint')}
                </span>
              </Link>
            </li>
            {owner && info?.device?.is_admin && info.enrolled ? (
              <li>
                <Link to="/settings/devices" className={rowLink}>
                  <span className="font-medium">{t('devices.title')}</span>
                  <span className="text-small text-text-muted">
                    {t('office.settings.nav_devices_hint')}
                  </span>
                </Link>
              </li>
            ) : null}
            {can('export.data') && role === 'owner' ? (
              <li>
                <Link to="/settings/backup" className={rowLink}>
                  <span className="font-medium">
                    {t('office.backup.title')}
                  </span>
                  <span className="text-small text-text-muted">
                    {t('office.backup.nav_hint')}
                  </span>
                </Link>
              </li>
            ) : null}
            <li>
              <Link to="/settings/about" className={rowLink}>
                <span className="font-medium">
                  {t('office.settings.nav_about')}
                </span>
                <span className="text-small text-text-muted">
                  {t('office.settings.nav_about_hint')}
                </span>
              </Link>
            </li>
          </ul>
        </section>
      </nav>
      {info?.device ? (
        <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
          <h2 className="font-medium">
            {t('office.settings.nav_this_device')}
          </h2>
          <p className="text-small text-text-muted" data-testid="this-device">
            {info.tenant?.display_name ?? ''} · {info.device.name} ·{' '}
            {info.device.code} ·{' '}
            {info.device.is_admin
              ? t('office.settings.nav_admin_device')
              : t('office.settings.nav_till_device')}
          </p>
          {owner && info.enrolled ? (
            <>
              <p className="text-small">
                {t('office.settings.nav_leave_hint')}
              </p>
              <button
                type="button"
                className={`${buttonDanger} self-start`}
                onClick={() => void leave()}
              >
                {t('office.settings.nav_leave')}
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
