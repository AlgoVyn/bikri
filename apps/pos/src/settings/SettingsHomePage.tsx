import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonDanger } from '../components/classes.ts';
import {
  ClockIcon,
  CloudIcon,
  DeviceIcon,
  GlobeIcon,
  InfoIcon,
  PrinterIcon,
  SettingsIcon,
  StoreIcon,
  TagIcon,
  UsersIcon,
} from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { getDb } from '../data/db.ts';
import { deviceInfo, tenantInfo } from '../data/localTenant.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

const rowLink = 'flex min-h-14 items-center gap-3 p-3';

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
      <PageHeader
        icon={<SettingsIcon />}
        tone="bg-surface-2 text-text-muted"
        title={t('nav.settings')}
        subtitle={t('office.settings.subtitle')}
      />
      <nav className="flex flex-col gap-4">
        {can('settings.shop') ? (
          <section>
            <h2 className="mb-1 px-1 text-small font-semibold text-text-muted">
              {t('office.settings.nav_group_shop')}
            </h2>
            <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
              <SettingsRow
                to="/settings/shop"
                icon={<StoreIcon />}
                title={t('office.settings.nav_shop')}
                hint={t('office.settings.nav_shop_hint')}
              />
              {can('settings.staff') ? (
                <SettingsRow
                  to="/settings/cashiers"
                  icon={<UsersIcon />}
                  title={t('office.settings.nav_cashiers')}
                  hint={t('office.settings.nav_cashiers_hint')}
                />
              ) : null}
              <SettingsRow
                to="/settings/activity"
                icon={<ClockIcon />}
                title={t('office.settings.nav_activity')}
                hint={t('office.settings.nav_activity_hint')}
              />
            </ul>
          </section>
        ) : null}
        <section>
          <h2 className="mb-1 px-1 text-small font-semibold text-text-muted">
            {t('office.settings.nav_group_device')}
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
            <SettingsRow
              to="/settings/printer"
              icon={<PrinterIcon />}
              title={t('printer.title')}
              hint={t('office.settings.nav_printer_hint')}
            />
            {can('catalog.edit') ? (
              <SettingsRow
                to="/settings/labels"
                icon={<TagIcon />}
                title={t('office.settings.nav_labels')}
                hint={t('office.settings.nav_labels_hint')}
              />
            ) : null}
            <SettingsRow
              to="/settings/display"
              icon={<SettingsIcon />}
              title={t('office.settings.nav_display')}
              hint={t('office.settings.nav_display_hint')}
            />
            <SettingsRow
              to="/settings/display"
              icon={<GlobeIcon />}
              title={t('office.settings.nav_language')}
              hint={t('office.settings.nav_language_hint')}
            />
          </ul>
        </section>
        <section>
          <h2 className="mb-1 px-1 text-small font-semibold text-text-muted">
            {t('office.settings.nav_group_data')}
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
            <SettingsRow
              to="/settings/sync"
              icon={<CloudIcon />}
              title={t('syncpage.title')}
              hint={t('office.settings.nav_sync_hint')}
            />
            {owner && info?.device?.is_admin && info.enrolled ? (
              <SettingsRow
                to="/settings/devices"
                icon={<DeviceIcon />}
                title={t('devices.title')}
                hint={t('office.settings.nav_devices_hint')}
              />
            ) : null}
            {can('export.data') && role === 'owner' ? (
              <SettingsRow
                to="/settings/backup"
                icon={<CloudIcon />}
                title={t('office.backup.title')}
                hint={t('office.backup.nav_hint')}
              />
            ) : null}
            <SettingsRow
              to="/settings/about"
              icon={<InfoIcon />}
              title={t('office.settings.nav_about')}
              hint={t('office.settings.nav_about_hint')}
            />
          </ul>
        </section>
      </nav>
      {info?.device ? (
        <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-text-muted">
              <DeviceIcon />
            </span>
            <div className="min-w-0">
              <h2 className="font-medium">
                {t('office.settings.nav_this_device')}
              </h2>
              <p
                className="text-small text-text-muted"
                data-testid="this-device"
              >
                {info.tenant?.display_name ?? ''} · {info.device.name} ·{' '}
                {info.device.code} ·{' '}
                {info.device.is_admin
                  ? t('office.settings.nav_admin_device')
                  : t('office.settings.nav_till_device')}
              </p>
            </div>
          </div>
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

function SettingsRow({
  to,
  icon,
  title,
  hint,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <li>
      <Link to={to} className={rowLink}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-text-muted">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{title}</span>
          <span className="block text-small text-text-muted">{hint}</span>
        </span>
        <span
          aria-hidden="true"
          className="text-title text-text-muted rtl:rotate-180"
        >
          ›
        </span>
      </Link>
    </li>
  );
}
