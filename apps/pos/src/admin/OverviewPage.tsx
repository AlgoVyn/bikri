import {
  Badge,
  Box,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudIcon, ReportsIcon } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  AdminApiError,
  adminErrorMessage,
  getUsage,
  listTenants,
} from './api.ts';
import {
  adminHref,
  BACKUP_STALE_MS,
  D1_LIMIT_BYTES,
  FREE_READS_PER_DAY,
  FREE_WRITES_PER_DAY,
  formatBytes,
  formatCount,
  formatWhen,
  knownStatuses,
  SHOP_SHARE,
} from './format.ts';
import type { TenantListItem, UsageOverview } from './types.ts';
import { Meter, Panel, StatCard, StatusBadge } from './ui.tsx';

export function OverviewPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [usage, setUsage] = useState<UsageOverview | null>(null);
  const [tenants, setTenants] = useState<TenantListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const request = tick;
    setError(null);
    void Promise.all([getUsage(), listTenants()])
      .then(async ([nextUsage, list]) => {
        if (cancelled || request !== tick) return;
        setUsage(nextUsage);
        setTenants(list.tenants);
      })
      .catch((err: unknown) => {
        if (cancelled || request !== tick) return;
        const message =
          err instanceof AdminApiError && err.status === 403
            ? t('admin.err_not_operator')
            : adminErrorMessage(err, t('admin.err_generic'));
        setError(message);
        toast.push(message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast, tick]);

  if (error !== null && usage === null) {
    return <Text c="dimmed">{error}</Text>;
  }
  if (usage === null) {
    return <Text className="sr-only">{t('common.loading')}</Text>;
  }
  const lang = i18n.language;
  const writeShare = Math.round(FREE_WRITES_PER_DAY * SHOP_SHARE);
  const readShare = Math.round(FREE_READS_PER_DAY * SHOP_SHARE);
  const backup = usage.last_backup;
  const stale =
    backup !== null && Date.now() - backup.uploaded > BACKUP_STALE_MS;
  const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  const open = usage.open_conflicts.map((row) => ({
    id: row.tenant_id,
    name: byId.get(row.tenant_id)?.display_name ?? row.tenant_id,
    count: row.count,
  }));
  const active = usage.tenants_by_status.active ?? 0;
  const devices = tenants.reduce((sum, tenant) => sum + tenant.devices, 0);
  const setup = tenants.filter((tenant) => tenant.setup_completed).length;
  const conflictTotal = open.reduce((sum, row) => sum + row.count, 0);
  const backupOk = backup !== null && !stale;
  const quiet = open.length === 0 && usage.over_80.length === 0 && backupOk;

  return (
    <Stack gap="lg">
      <PageHeader
        icon={<ReportsIcon />}
        title={t('admin.overview_title')}
        subtitle={t('admin.overview_subtitle')}
        actions={
          <>
            <Badge variant="light" color="gray" tt="none" radius="xl">
              {t('admin.signed_in', { email: usage.email })}
            </Badge>
            <Button
              type="button"
              variant="default"
              onClick={() => setTick((value) => value + 1)}
            >
              {t('admin.refresh')}
            </Button>
          </>
        }
      />

      <SimpleGrid cols={{ base: 2, xl: 4 }} spacing="sm">
        <StatCard
          label={t('admin.stat_shops')}
          value={formatCount(tenants.length, lang)}
        />
        <StatCard
          label={t('admin.stat_active')}
          value={formatCount(active, lang)}
        />
        <StatCard
          label={t('admin.stat_devices')}
          value={formatCount(devices, lang)}
        />
        <StatCard
          label={t('admin.stat_setup')}
          value={formatCount(setup, lang)}
          hint={t('admin.stat_setup_hint', {
            done: formatCount(setup, lang),
            total: formatCount(tenants.length, lang),
          })}
        />
      </SimpleGrid>

      <SimpleGrid
        cols={{ base: 1, xl: 2 }}
        spacing="md"
        style={{ alignItems: 'start' }}
      >
        <Stack gap="md">
          <Panel
            title={t('admin.usage_today')}
            description={t('admin.usage_today_hint')}
          >
            <Stack gap="md">
              <Group
                justify="space-between"
                align="flex-end"
                gap="sm"
                wrap="wrap"
                pb="sm"
                style={{
                  borderBottom: '1px solid var(--mantine-color-default-border)',
                }}
              >
                <Box>
                  <Text size="sm" c="dimmed">
                    {t('admin.d1_size')}
                  </Text>
                  <Text
                    fz={22}
                    fw={600}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {usage.db_size_bytes === null
                      ? t('admin.never')
                      : formatBytes(usage.db_size_bytes, lang)}
                  </Text>
                </Box>
                <Text
                  size="sm"
                  c="dimmed"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {t('admin.d1_limit', {
                    limit: formatBytes(D1_LIMIT_BYTES, lang),
                  })}
                </Text>
              </Group>
              <Meter
                label={t('admin.writes_today')}
                value={usage.today.rows_written}
                max={FREE_WRITES_PER_DAY}
                warnAt={writeShare}
                valueText={t('admin.of_limit', {
                  value: formatCount(usage.today.rows_written, lang),
                  limit: formatCount(FREE_WRITES_PER_DAY, lang),
                })}
              />
              <Text size="sm" c="dimmed">
                {t('admin.share_70', {
                  value: formatCount(writeShare, lang),
                })}
              </Text>
              <Meter
                label={t('admin.reads_today')}
                value={usage.today.rows_read}
                max={FREE_READS_PER_DAY}
                warnAt={readShare}
                valueText={t('admin.of_limit', {
                  value: formatCount(usage.today.rows_read, lang),
                  limit: formatCount(FREE_READS_PER_DAY, lang),
                })}
              />
              <Text size="sm" c="dimmed">
                {t('admin.share_70', {
                  value: formatCount(readShare, lang),
                })}
              </Text>
            </Stack>
          </Panel>

          <Panel
            title={t('admin.by_status')}
            description={t('admin.by_status_hint')}
          >
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
              {knownStatuses().map((status) => (
                <Paper
                  key={status}
                  p="sm"
                  bg="var(--mantine-color-default-hover)"
                >
                  <Group justify="space-between" gap="sm">
                    <StatusBadge status={status} />
                    <Text
                      fw={600}
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {formatCount(usage.tenants_by_status[status] ?? 0, lang)}
                    </Text>
                  </Group>
                </Paper>
              ))}
            </SimpleGrid>
          </Panel>
        </Stack>

        <Panel
          title={t('admin.needs_attention')}
          description={t('admin.needs_attention_hint')}
        >
          <Stack gap="md">
            <Box component="section" aria-labelledby="backup-row">
              <Group align="flex-start" gap="sm" wrap="nowrap">
                <ThemeIcon
                  size={40}
                  radius="md"
                  variant="light"
                  color={backup === null || stale ? 'warning' : 'success'}
                >
                  <CloudIcon />
                </ThemeIcon>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Title order={3} fz="sm" id="backup-row">
                    {t('admin.last_backup')}
                  </Title>
                  {backup === null ? (
                    <Text size="sm" c="dimmed">
                      {t('admin.backup_never')}
                    </Text>
                  ) : (
                    <Text size="sm" c="dimmed">
                      {formatWhen(backup.uploaded, lang)} ·{' '}
                      {formatBytes(backup.size, lang)}
                    </Text>
                  )}
                </Box>
                <Badge
                  variant="light"
                  color={backup === null || stale ? 'warning' : 'success'}
                  tt="none"
                  radius="xl"
                >
                  {backup === null
                    ? t('admin.never')
                    : stale
                      ? t('admin.backup_old')
                      : t('admin.backup_ok')}
                </Badge>
              </Group>
            </Box>

            <Box
              component="section"
              pt="md"
              aria-labelledby="over-budget-row"
              style={{
                borderTop: '1px solid var(--mantine-color-default-border)',
              }}
            >
              <Group justify="space-between" gap="sm">
                <Title order={3} fz="sm" id="over-budget-row">
                  {t('admin.over_80')}
                </Title>
                <Badge
                  variant="light"
                  color={usage.over_80.length === 0 ? 'gray' : 'warning'}
                  tt="none"
                  radius="xl"
                >
                  {formatCount(usage.over_80.length, lang)}
                </Badge>
              </Group>
              <Text size="sm" c="dimmed" mt={2}>
                {t('admin.over_80_hint')}
              </Text>
              {usage.over_80.length === 0 ? (
                <Text size="sm" c="dimmed" mt="sm">
                  {t('admin.over_80_none')}
                </Text>
              ) : (
                <Stack gap={0} mt="xs">
                  {usage.over_80.map((id) => {
                    const tenant = byId.get(id);
                    return (
                      <Button
                        key={id}
                        component="a"
                        href={adminHref(`/admin/tenants/${id}`)}
                        variant="transparent"
                        justify="space-between"
                        size="compact-sm"
                        px={4}
                      >
                        <Text component="span" size="sm" truncate>
                          {tenant?.display_name ?? id}
                        </Text>
                        <Text component="span" aria-hidden="true">
                          ›
                        </Text>
                      </Button>
                    );
                  })}
                </Stack>
              )}
            </Box>

            <Box
              component="section"
              pt="md"
              aria-labelledby="conflicts-row"
              style={{
                borderTop: '1px solid var(--mantine-color-default-border)',
              }}
            >
              <Group justify="space-between" gap="sm">
                <Title order={3} fz="sm" id="conflicts-row">
                  {t('admin.conflicts')}
                </Title>
                <Badge
                  variant="light"
                  color={conflictTotal === 0 ? 'success' : 'danger'}
                  tt="none"
                  radius="xl"
                >
                  {formatCount(conflictTotal, lang)}
                </Badge>
              </Group>
              <Text size="sm" c="dimmed" mt={2}>
                {t('admin.conflicts_hint')}
              </Text>
              {open.length === 0 ? (
                <Text size="sm" c="dimmed" mt="sm">
                  {t('admin.conflicts_none')}
                </Text>
              ) : (
                <Stack gap={0} mt="xs">
                  {open.map((row) => (
                    <Button
                      key={row.id}
                      component="a"
                      href={adminHref(`/admin/tenants/${row.id}`)}
                      variant="transparent"
                      justify="space-between"
                      size="compact-sm"
                      px={4}
                    >
                      <Text component="span" size="sm" truncate>
                        {row.name}
                      </Text>
                      <Text component="span" size="sm" c="dimmed">
                        {formatCount(row.count, lang)}
                      </Text>
                    </Button>
                  ))}
                </Stack>
              )}
            </Box>

            {quiet ? (
              <Group
                gap="sm"
                pt="md"
                style={{
                  borderTop: '1px solid var(--mantine-color-default-border)',
                }}
              >
                <Box
                  aria-hidden="true"
                  w={8}
                  h={8}
                  style={{
                    borderRadius: 999,
                    background: 'var(--color-success)',
                  }}
                />
                <Text size="sm" fw={500} c="var(--color-success)">
                  {t('admin.attention_none')}
                </Text>
              </Group>
            ) : null}
          </Stack>
        </Panel>
      </SimpleGrid>
    </Stack>
  );
}
