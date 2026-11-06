import { Link, useLocation } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { buttonDanger } from '../components/classes.ts';
import {
  ClockIcon,
  CloudIcon,
  DeviceIcon,
  InfoIcon,
  PrinterIcon,
  SearchIcon,
  SettingsIcon,
  StoreIcon,
  TagIcon,
  UsersIcon,
} from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { getDb } from '../data/db.ts';
import { deviceInfo, tenantInfo } from '../data/localTenant.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { rememberListScroll } from '../lib/listScroll.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

const rowLink = 'flex min-h-14 items-center gap-3 p-3';

/** The shared Settings index: groups, this-device card and leave action. */
export function SettingsNav() {
  return (
    <AreaStrings area="office">
      <SettingsNavContent />
    </AreaStrings>
  );
}

function SettingsNavContent() {
  const { t } = useTranslation();
  const { role, can, support } = useCurrentStaff();
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const info = useLiveQuery(async () => {
    const db = getDb();
    const [device, tenant, enrolled, pending, lastSync, printer, storage] =
      await Promise.all([
        deviceInfo(db),
        tenantInfo(db),
        db.kv.get('device_token').then((row) => Boolean(row?.value)),
        db.outbox.where('status').equals('pending').count(),
        db.kv.get('last_sync_at').then((row) => Number(row?.value ?? 0)),
        db.kv.get('printer').then((row) => Boolean(row?.value)),
        navigator.storage?.estimate?.().catch(() => null) ?? null,
      ]);
    return {
      device,
      tenant,
      enrolled,
      pending,
      lastSync,
      printer,
      storageBytes: storage?.usage ?? null,
    };
  }, []);
  const owner = role === 'owner';
  const [confirmLeave, setConfirmLeave] = useState(false);
  const leave = async () => {
    setLeaveError(null);
    const db = getDb();
    const { leaveShop, PendingFilesError, UnsyncedOpsError } = await import(
      '../data/enrol.ts'
    );
    try {
      await leaveShop(db);
      window.location.assign(`${import.meta.env.BASE_URL || '/'}enrol`);
    } catch (e) {
      setLeaveError(
        e instanceof UnsyncedOpsError
          ? t('enrol.leave_blocked', { count: e.count })
          : e instanceof PendingFilesError
            ? t('enrol.leave_files_blocked', { count: e.count })
            : String(e),
      );
    }
  };
  const q = query.trim().toLowerCase();
  const match = (title: string, hint: string) =>
    !q || `${title} ${hint}`.toLowerCase().includes(q);
  const rows = [
    {
      group: 'shop',
      to: '/settings/shop',
      icon: <StoreIcon />,
      title: t('office.settings.nav_shop'),
      hint: t('office.settings.nav_shop_hint'),
      show: can('settings.shop'),
    },
    {
      group: 'shop',
      to: '/settings/cashiers',
      icon: <UsersIcon />,
      title: t('office.settings.nav_cashiers'),
      hint: t('office.settings.nav_cashiers_hint'),
      show: can('settings.staff'),
    },
    {
      group: 'shop',
      to: '/settings/activity',
      icon: <ClockIcon />,
      title: t('office.settings.nav_activity'),
      hint: t('office.settings.nav_activity_hint'),
      show: can('settings.shop'),
    },
    {
      group: 'device',
      to: '/settings/printer',
      icon: <PrinterIcon />,
      title: t('printer.title'),
      hint: t('office.settings.nav_printer_hint'),
      show: true,
    },
    {
      group: 'device',
      to: '/settings/labels',
      icon: <TagIcon />,
      title: t('office.settings.nav_labels'),
      hint: t('office.settings.nav_labels_hint'),
      show: can('catalog.edit'),
    },
    {
      group: 'device',
      to: '/settings/display',
      icon: <SettingsIcon />,
      title: t('office.settings.nav_display'),
      hint: t('office.settings.nav_display_hint'),
      show: true,
    },
    {
      group: 'data',
      to: '/settings/sync',
      icon: <CloudIcon />,
      title: t('syncpage.title'),
      hint: t('office.settings.nav_sync_hint'),
      show: true,
    },
    {
      group: 'data',
      to: '/settings/devices',
      icon: <DeviceIcon />,
      title: t('devices.title'),
      hint: t('office.settings.nav_devices_hint'),
      show:
        support || Boolean(owner && info?.device?.is_admin && info.enrolled),
    },
    {
      group: 'data',
      to: '/settings/backup',
      icon: <CloudIcon />,
      title: t('office.backup.title'),
      hint: t('office.backup.nav_hint'),
      show: can('export.data') && owner,
    },
    {
      group: 'data',
      to: '/settings/about',
      icon: <InfoIcon />,
      title: t('office.settings.nav_about'),
      hint: t('office.settings.nav_about_hint'),
      show: true,
    },
  ].filter((row) => row.show && match(row.title, row.hint));
  const groups = [
    { id: 'shop', label: t('office.settings.nav_group_shop') },
    { id: 'device', label: t('office.settings.nav_group_device') },
    { id: 'data', label: t('office.settings.nav_group_data') },
  ]
    .map((group) => ({
      ...group,
      rows: rows.filter((row) => row.group === group.id),
    }))
    .filter((group) => group.rows.length > 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<SettingsIcon />}
        title={t('nav.settings')}
        subtitle={t('office.settings.subtitle')}
      />
      <section
        aria-labelledby="data-safety"
        className="rounded-card border border-border bg-surface p-3"
      >
        <h2 id="data-safety" className="text-h2 font-semibold">
          {t('office.settings.health_title')}
        </h2>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-small">
          <div>
            <dt className="text-text-muted">
              {t('office.settings.health_sync')}
            </dt>
            <dd className="font-medium">
              {info?.pending
                ? t('office.settings.health_pending', {
                    count: info.pending,
                  })
                : t('office.settings.health_up_to_date')}
              <span className="block text-caption font-normal text-text-muted">
                {t('office.settings.health_last_sync')}:{' '}
                {info?.lastSync
                  ? t('shell.sync_ago', {
                      minutes: Math.max(
                        0,
                        Math.round((Date.now() - info.lastSync) / 60_000),
                      ),
                    })
                  : t('shell.sync_never')}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">
              {t('office.settings.health_storage')}
            </dt>
            <dd className="font-medium">
              {info?.storageBytes ? (
                <bdi dir="ltr">
                  {t('office.settings.health_storage_value', {
                    mb: Math.max(1, Math.round(info.storageBytes / 1_048_576)),
                  })}
                </bdi>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">
              {t('office.settings.health_backup')}
            </dt>
            <dd className="font-medium">
              {owner && can('export.data') ? (
                <Link to="/settings/backup" className="text-primary">
                  {t('office.settings.health_backup_value')}
                </Link>
              ) : (
                t('office.settings.health_backup_value')
              )}
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">
              {t('office.settings.health_printer')}
            </dt>
            <dd className="font-medium">
              <Link to="/settings/printer" className="text-primary">
                {info?.printer
                  ? t('shell.printer_ready')
                  : t('shell.printer_none')}
              </Link>
            </dd>
          </div>
        </dl>
      </section>

      <label className="flex h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-3">
        <SearchIcon />
        <span className="sr-only">{t('office.settings.health_search')}</span>
        <input
          type="search"
          className="min-w-0 flex-1 bg-transparent text-body outline-none"
          placeholder={t('office.settings.health_search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <nav aria-label={t('nav.settings')} className="flex flex-col gap-4">
        {groups.map((group) => (
          <section key={group.id}>
            <h2 className="mb-1 px-1 text-small font-semibold text-text-muted">
              {group.label}
            </h2>
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
              {group.rows.map((row) => (
                <SettingsRow
                  key={row.to}
                  to={row.to}
                  icon={row.icon}
                  title={row.title}
                  hint={row.hint}
                />
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 ? (
          <p className="px-1 text-small text-text-muted">
            {t('office.settings.health_no_results')}
          </p>
        ) : null}
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
                onClick={() => setConfirmLeave(true)}
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
      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title={t('enrol.leave')}
        body={t('enrol.leave_confirm', {
          shop: info?.tenant?.display_name ?? '',
        })}
        confirmLabel={t('office.settings.nav_leave')}
        onConfirm={() => void leave()}
      />
    </div>
  );
}

function SettingsRow({
  to,
  icon,
  title,
  hint,
  active,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  hint: string;
  active?: boolean;
}) {
  const { pathname } = useLocation();
  const current =
    active ?? pathname.replace(/\/+$/u, '') === to.replace(/\/+$/u, '');
  return (
    <li>
      <Link
        to={to}
        resetScroll={false}
        onClick={rememberListScroll}
        aria-current={current ? 'page' : undefined}
        className={`${rowLink} ${
          current
            ? 'bg-primary-subtle text-primary-subtle-ink'
            : 'hover:bg-surface-2'
        }`}
      >
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-control ${
            current
              ? 'bg-surface text-primary-subtle-ink'
              : 'bg-surface-2 text-text-muted'
          }`}
        >
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
