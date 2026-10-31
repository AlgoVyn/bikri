import { businessDate } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { downloadText } from '../lib/download.ts';
import { addDays, longDate, timeText } from '../reports/format.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { SettingsGuard } from './Guard.tsx';
import { SettingsPageLayout } from './Layout.tsx';

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
      <Stack gap="sm">
        <Paper withBorder p="sm">
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} spacing="sm">
            <TextInput
              type="date"
              label={t('office.activity.from')}
              value={filters.from}
              max={filters.to}
              onChange={(event) => update({ from: event.currentTarget.value })}
            />
            <TextInput
              type="date"
              label={t('office.activity.to')}
              value={filters.to}
              min={filters.from}
              max={today}
              onChange={(event) => update({ to: event.currentTarget.value })}
            />
            <NativeSelect
              label={t('office.activity.action')}
              value={filters.action ?? ''}
              onChange={(event) =>
                update({ action: event.currentTarget.value || undefined })
              }
              data={[
                { value: '', label: t('office.activity.all_actions') },
                ...AUDIT_ACTIONS.map((action) => ({
                  value: action,
                  label: t(`office.activity.action_${action}`, {
                    defaultValue: action,
                  }),
                })),
              ]}
            />
            <NativeSelect
              label={t('office.activity.staff')}
              value={filters.staffId ?? ''}
              onChange={(event) =>
                update({ staffId: event.currentTarget.value || undefined })
              }
              data={[
                { value: '', label: t('office.activity.all_staff') },
                ...(options?.staff.map((row) => ({
                  value: row.id,
                  label: String(row.name),
                })) ?? []),
              ]}
            />
            <NativeSelect
              label={t('office.activity.device')}
              value={filters.deviceId ?? ''}
              onChange={(event) =>
                update({ deviceId: event.currentTarget.value || undefined })
              }
              data={[
                { value: '', label: t('office.activity.all_devices') },
                ...(options?.devices.map((row) => ({
                  value: row.id,
                  label: String(row.name ?? row.code ?? ''),
                })) ?? []),
              ]}
            />
          </SimpleGrid>
        </Paper>
        {can('export.data') ? (
          <Group justify="flex-end">
            <Button
              type="button"
              variant="default"
              disabled={!rows || rows.length === 0}
              onClick={() =>
                rows &&
                downloadText('bikri-activity.csv', auditCsv(rows, timeZone))
              }
            >
              {t('office.activity.export_csv')}
            </Button>
          </Group>
        ) : null}
        {rows && rows.length === 0 ? (
          <EmptyState message={t('office.activity.empty')} />
        ) : null}
        {rows && rows.length > 0 ? (
          <Paper withBorder>
            <Box
              tabIndex={0}
              role="region"
              aria-label={t('office.activity.title')}
              style={{ overflowX: 'auto' }}
            >
              <Table fz="sm" miw={704}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('office.activity.time')}</Table.Th>
                    <Table.Th>{t('office.activity.staff')}</Table.Th>
                    <Table.Th>{t('office.activity.device')}</Table.Th>
                    <Table.Th>{t('office.activity.action')}</Table.Th>
                    <Table.Th>{t('office.activity.summary')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((entry) => (
                    <Table.Tr key={String(entry.row.id)}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>
                        <Text size="sm" component="bdi" dir="ltr">
                          {longDate(
                            businessDate(
                              Number(entry.row.created_at),
                              timeZone,
                            ),
                            i18n.language,
                          )}{' '}
                          {timeText(
                            Number(entry.row.created_at),
                            i18n.language,
                            timeZone,
                          )}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {entry.staffName || String(entry.row.staff_id ?? '—')}
                      </Table.Td>
                      <Table.Td>
                        {entry.deviceName || String(entry.row.device_id ?? '—')}
                      </Table.Td>
                      <Table.Td>
                        {t(
                          `office.activity.action_${String(entry.row.action)}`,
                          { defaultValue: String(entry.row.action) },
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {entry.summary}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Box>
          </Paper>
        ) : null}
      </Stack>
    </SettingsPageLayout>
  );
}
