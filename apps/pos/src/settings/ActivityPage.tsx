import { businessDate } from '@bikri/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from '../components/classes.ts';
import { DateField } from '../components/DateField.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { ClockIcon } from '../components/icons.tsx';
import { ListPager } from '../components/ListPager.tsx';
import { getDb } from '../data/db.ts';
import {
  AUDIT_ACTIONS,
  type AuditFilters,
  auditCsv,
  filterAuditRows,
  loadAuditRows,
} from '../data/settings.ts';
import { useShopTimeZone } from '../data/useShopTimeZone.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { downloadText } from '../lib/download.ts';
import { addDays, longDate, timeText } from '../lib/reportFormat.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { SettingsGuard } from './Guard.tsx';
import { SettingsPageLayout } from './Layout.tsx';

const field =
  'h-11 min-w-0 rounded-control border border-border-strong bg-surface px-2 text-text';

const PAGE = 100;

/** Activity viewer over audit_log (screens/17). */
export function ActivityPage() {
  return (
    <AreaStrings area="office">
      <SettingsGuard permission="settings.shop">
        <ActivityContent />
      </SettingsGuard>
    </AreaStrings>
  );
}

function ActivityContent() {
  const { t, i18n } = useTranslation();
  const { can } = useCurrentStaff();
  const timeZone = useShopTimeZone();
  // The shop's business date, not the device's Karachi date (13 §3).
  const today = businessDate(Date.now(), timeZone);
  const [filters, setFilters] = useState<AuditFilters>(() => ({
    from: addDays(today, -29),
    to: today,
  }));
  // A late time-zone read must not overwrite a filter the owner already changed.
  const seededToday = useRef(today);
  useEffect(() => {
    if (seededToday.current === today) return;
    const previous = seededToday.current;
    seededToday.current = today;
    setFilters((current) =>
      current.to === previous && current.from === addDays(previous, -29)
        ? { ...current, from: addDays(today, -29), to: today }
        : current.to === previous
          ? { ...current, to: today }
          : current,
    );
  }, [today]);
  const options = useLiveQuery(async () => {
    const db = getDb();
    const staff = (await db.staff.toArray()).filter((row) => !row.deleted_at);
    const devices = await db.devices.toArray();
    return {
      staff: staff.sort((a, b) => String(a.name).localeCompare(String(b.name))),
      devices: devices.sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      ),
    };
  }, []);
  const auditRows = useLiveQuery(
    () => loadAuditRows(getDb(), filters.from, filters.to),
    [filters.from, filters.to],
  );
  const rows = useMemo(
    () => (auditRows ? filterAuditRows(auditRows, filters) : undefined),
    [auditRows, filters],
  );
  const update = (patch: Partial<AuditFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  const [page, setPage] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the range/filter changes
  useEffect(
    () => setPage(0),
    [
      filters.from,
      filters.to,
      filters.action,
      filters.staffId,
      filters.deviceId,
    ],
  );
  const pageCount = Math.max(1, Math.ceil((rows?.length ?? 0) / PAGE));
  const pageRows = rows?.slice(page * PAGE, (page + 1) * PAGE) ?? [];
  return (
    <SettingsPageLayout title={t('office.activity.title')} icon={<ClockIcon />}>
      <div className="rounded-card border border-divider bg-surface">
        <div className="border-b border-divider p-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <DateField
              label={t('office.activity.from')}
              value={filters.from}
              max={filters.to}
              onChange={(value) => {
                if (value) update({ from: value });
              }}
            />
            <DateField
              label={t('office.activity.to')}
              value={filters.to}
              min={filters.from}
              max={today}
              onChange={(value) => {
                if (value) update({ to: value });
              }}
            />
            <label className="flex flex-col gap-1 text-small">
              {t('office.activity.action')}
              <select
                className={field}
                value={filters.action ?? ''}
                onChange={(event) =>
                  update({ action: event.target.value || undefined })
                }
              >
                <option value="">{t('office.activity.all_actions')}</option>
                {AUDIT_ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {t(`office.activity.action_${action}`, {
                      defaultValue: action,
                    })}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-small">
              {t('office.activity.staff')}
              <select
                className={field}
                value={filters.staffId ?? ''}
                onChange={(event) =>
                  update({ staffId: event.target.value || undefined })
                }
              >
                <option value="">{t('office.activity.all_staff')}</option>
                {options?.staff.map((row) => (
                  <option key={row.id} value={row.id}>
                    {String(row.name)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-small">
              {t('office.activity.device')}
              <select
                className={field}
                value={filters.deviceId ?? ''}
                onChange={(event) =>
                  update({ deviceId: event.target.value || undefined })
                }
              >
                <option value="">{t('office.activity.all_devices')}</option>
                {options?.devices.map((row) => (
                  <option key={row.id} value={row.id}>
                    {String(row.name ?? row.code ?? '')}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {can('export.data') ? (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                className={buttonQuiet}
                disabled={!rows || rows.length === 0}
                onClick={() =>
                  rows &&
                  downloadText('bikri-activity.csv', auditCsv(rows, timeZone))
                }
              >
                {t('office.activity.export_csv')}
              </button>
            </div>
          ) : null}
        </div>
        {rows && rows.length === 0 ? (
          <EmptyState
            variant="plain"
            icon={<ClockIcon />}
            message={t('office.activity.empty')}
            actionLabel={t('common.clear_filters')}
            onAction={() =>
              setFilters({ from: addDays(today, -29), to: today })
            }
          />
        ) : null}
        {rows && rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse text-small">
              <thead>
                <tr className="border-b border-divider bg-surface-2">
                  <th className="px-3 py-2 text-start">
                    {t('office.activity.time')}
                  </th>
                  <th className="px-3 py-2 text-start">
                    {t('office.activity.staff')}
                  </th>
                  <th className="px-3 py-2 text-start">
                    {t('office.activity.device')}
                  </th>
                  <th className="px-3 py-2 text-start">
                    {t('office.activity.action')}
                  </th>
                  <th className="px-3 py-2 text-start">
                    {t('office.activity.summary')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((entry) => (
                  <tr
                    key={String(entry.row.id)}
                    className="border-b border-divider last:border-0"
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      {longDate(
                        businessDate(Number(entry.row.created_at), timeZone),
                        i18n.language,
                      )}{' '}
                      {timeText(
                        Number(entry.row.created_at),
                        i18n.language,
                        timeZone,
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {entry.staffName || String(entry.row.staff_id ?? '—')}
                    </td>
                    <td className="px-3 py-2">
                      {entry.deviceName || String(entry.row.device_id ?? '—')}
                    </td>
                    <td className="px-3 py-2">
                      {t(`office.activity.action_${String(entry.row.action)}`, {
                        defaultValue: String(entry.row.action),
                      })}
                    </td>
                    <td className="px-3 py-2 text-text-muted">
                      {entry.summary}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {rows && rows.length > 0 ? (
          <ListPager page={page} pageCount={pageCount} onPage={setPage} />
        ) : null}
      </div>
    </SettingsPageLayout>
  );
}
