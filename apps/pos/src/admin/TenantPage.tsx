import {
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StoreIcon } from '../components/icons.tsx';
import { useToast } from '../components/Toast.tsx';
import { adminErrorMessage, getTenant, setMaintenance } from './api.ts';
import { DeleteTab } from './DeleteTab.tsx';
import { DevicesTab } from './DevicesTab.tsx';
import { ExportTab } from './ExportTab.tsx';
import { adminHref, formatWhen, tenantBandColor } from './format.ts';
import { PinTab } from './PinTab.tsx';
import { RestoreTab } from './RestoreTab.tsx';
import {
  clearRestoreState,
  type RestoreState,
  readRestoreState,
} from './restore.ts';
import { SummaryTab } from './SummaryTab.tsx';
import { AdminConfirm, StatusBadge } from './ui.tsx';
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
  const { t, i18n } = useTranslation();
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
      <Stack gap="sm" align="flex-start">
        <Text c="dimmed">{query.error}</Text>
        <Button type="button" onClick={query.reload}>
          {t('admin.retry')}
        </Button>
      </Stack>
    ) : (
      <Text className="sr-only">{t('common.loading')}</Text>
    );
  }

  const tenant = detail.tenant;
  const maintenance = tenant.status === 'maintenance';
  const band = tenantBandColor(tenant.id);
  const lang = i18n.language;

  return (
    <Stack gap="lg">
      <Button
        component="a"
        href={adminHref('/admin/tenants')}
        variant="transparent"
        px={0}
        size="compact-sm"
        leftSection={<span aria-hidden="true">‹</span>}
        style={{ alignSelf: 'flex-start' }}
      >
        {t('admin.back_to_shops')}
      </Button>

      <Paper withBorder style={{ overflow: 'hidden' }}>
        <Box aria-hidden="true" h={4} style={{ background: band }} />
        <Group align="flex-start" gap="md" p="lg" wrap="nowrap">
          <ThemeIcon
            size={48}
            radius="md"
            style={{ background: band, color: '#fff' }}
          >
            <StoreIcon />
          </ThemeIcon>
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Group gap="sm" wrap="wrap" align="center">
              <Title order={1} fz="h2">
                {tenant.display_name}
              </Title>
              <StatusBadge status={tenant.status} />
            </Group>
            <Text size="sm" ff="monospace" c="dimmed" mt={2}>
              {tenant.slug}
            </Text>
            <Group gap="md" mt="xs">
              <Text size="sm" c="dimmed">
                {t('admin.owner_email')}:{' '}
                {tenant.owner_email ?? t('admin.never')}
              </Text>
              <Text size="sm" c="dimmed">
                {t('admin.devices_count', { count: detail.devices })}
              </Text>
              <Text size="sm" c="dimmed">
                {t('admin.created')}: {formatWhen(tenant.created_at, lang)}
              </Text>
              <Text size="sm" c="dimmed">
                {t('admin.setup_at')}:{' '}
                {detail.setup_completed_at === null
                  ? t('admin.setup_pending')
                  : formatWhen(detail.setup_completed_at, lang)}
              </Text>
            </Group>
          </Box>
        </Group>
      </Paper>

      {maintenance ? (
        <Paper p="md" role="status" bg="var(--mantine-color-warning-subtle)">
          <Group justify="space-between" gap="sm" wrap="wrap">
            <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
              {stored?.aborted
                ? t('admin.aborted_banner')
                : t('admin.maintenance_banner')}
            </Text>
            <Button
              type="button"
              variant="default"
              size="compact-sm"
              onClick={() => setOffOpen(true)}
            >
              {t('admin.end_maintenance')}
            </Button>
          </Group>
        </Paper>
      ) : null}

      <Tabs
        value={tab}
        onChange={(value) => setTab((value ?? 'summary') as Tab)}
        aria-label={tenant.display_name}
      >
        <Tabs.List>
          {TABS.map((item) => (
            <Tabs.Tab key={item.id} value={item.id}>
              {t(item.key)}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value={tab} pt="md">
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
        </Tabs.Panel>
      </Tabs>

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
      {pending ? <Text className="sr-only">{t('common.loading')}</Text> : null}
    </Stack>
  );
}
