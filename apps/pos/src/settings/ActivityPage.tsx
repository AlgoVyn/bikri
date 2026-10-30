import { businessDate } from '@bikri/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ClockIcon } from '../components/icons.tsx';
import { getDb } from '../data/db.ts';
import {
  AUDIT_ACTIONS,
  type AuditFilters,
  auditCsv,
  auditList,
} from '../data/settings.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { formatBusinessDate } from '../lib/date.ts';
import { downloadText } from '../lib/download.ts';
import { addDays, longDate, timeText } from '../reports/format.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { SettingsGuard } from './Guard.tsx';
import { SettingsPageLayout } from './Layout.tsx';

const field =
  'h-11 min-w-0 rounded-control border border-border-strong bg-surface px-2 text-text';

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
  const today = businessDate(Date.now());
  const [filters, setFilters] = useState<AuditFilters>({
    from: addDays(today, -29),
    to: today,
  });
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
  const rows = useLiveQuery(
    () => auditList(getDb(), filters),
    [
      filters.from,
      filters.to,
      filters.action,
      filters.staffId,
      filters.deviceId,
    ],
  );
  const update = (patch: Partial<AuditFilters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  const timeZone =
    useLiveQuery(async () => {
      const shop = await getDb().shop.get('shop');
      return String(shop?.timezone ?? 'Asia/Karachi');
    }, []) ?? 'Asia/Karachi';
  return (
    <SettingsPageLayout title={t('office.activity.title')} icon={<ClockIcon />}>
      <div className="grid gap-2 rounded-card border border-border bg-surface p-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="flex flex-col gap-1 text-small">
          {t('office.activity.from')}
          <input
            type="date"
            className={field}
            value={filters.from}
            max={filters.to}
            onChange={(event) => update({ from: event.target.value })}
          />
          <span className="text-text-muted">
            {formatBusinessDate(filters.from, i18n.language, timeZone)}
          </span>
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.activity.to')}
          <input
            type="date"
            className={field}
            value={filters.to}
            min={filters.from}
            max={today}
            onChange={(event) => update({ to: event.target.value })}
          />
          <span className="text-text-muted">
            {formatBusinessDate(filters.to, i18n.language, timeZone)}
          </span>
        </label>
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
        <div className="flex justify-end">
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
      {rows && rows.length === 0 ? (
        <EmptyState message={t('office.activity.empty')} />
      ) : null}
      {rows && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full min-w-[44rem] border-collapse text-small">
            <thead>
              <tr className="border-b border-border bg-surface-2">
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
              {rows.map((entry) => (
                <tr
                  key={String(entry.row.id)}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-3 py-2 whitespace-nowrap">
                    <bdi dir="ltr">
                      {longDate(
                        businessDate(Number(entry.row.created_at), timeZone),
                        i18n.language,
                      )}{' '}
                      {timeText(
                        Number(entry.row.created_at),
                        i18n.language,
                        timeZone,
                      )}
                    </bdi>
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
                  <td className="px-3 py-2 text-text-muted">{entry.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </SettingsPageLayout>
  );
}
