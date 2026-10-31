import {
  Box,
  Button,
  Group,
  NativeSelect,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
} from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchIcon, StoreIcon } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { listTenants } from './api.ts';
import {
  adminHref,
  formatCount,
  formatWhen,
  knownStatuses,
  statusLabelKey,
} from './format.ts';
import type { TenantListItem } from './types.ts';
import { StatusBadge } from './ui.tsx';
import { useAdminQuery } from './useAdminQuery.ts';

const PAGE_SIZE = 20;

export function TenantsPage() {
  const { t, i18n } = useTranslation();
  const query = useAdminQuery('tenants', listTenants);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const lang = i18n.language;
  if (query.data === null) {
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
  const tenants = query.data.tenants;
  const needle = search.trim().toLowerCase();
  const filtered = tenants.filter((tenant) => {
    if (status !== '' && tenant.status !== status) return false;
    if (needle === '') return true;
    return (
      tenant.display_name.toLowerCase().includes(needle) ||
      tenant.slug.toLowerCase().includes(needle)
    );
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const filtering = needle !== '' || status !== '';
  const clear = () => {
    setSearch('');
    setStatus('');
    setPage(1);
  };

  return (
    <Stack gap="lg">
      <PageHeader
        icon={<StoreIcon />}
        title={t('admin.tenants_title')}
        subtitle={t('admin.tenants_subtitle')}
        actions={
          <Button component="a" href={adminHref('/admin/tenants/new')}>
            {t('admin.new_shop')}
          </Button>
        }
      />

      <Paper withBorder p="sm">
        <Group align="flex-end" gap="sm" wrap="wrap">
          <TextInput
            type="search"
            aria-label={t('admin.search_shops')}
            placeholder={t('admin.search_shops_placeholder')}
            leftSection={<SearchIcon />}
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
              setPage(1);
            }}
            style={{ flex: '1 1 14rem', minWidth: 0 }}
          />
          <NativeSelect
            label={t('admin.filter_status')}
            value={status}
            onChange={(event) => {
              setStatus(event.currentTarget.value);
              setPage(1);
            }}
            data={[
              { value: '', label: t('admin.all_statuses') },
              ...knownStatuses().map((item) => ({
                value: item,
                label: t(statusLabelKey(item)),
              })),
            ]}
          />
          {filtering ? (
            <Button type="button" variant="default" onClick={clear}>
              {t('admin.clear_filters')}
            </Button>
          ) : null}
          <Text size="sm" c="dimmed" ms="auto" mb={8}>
            {t('admin.shops_count', {
              count: formatCount(filtered.length, lang),
            })}
          </Text>
        </Group>
      </Paper>

      {tenants.length === 0 ? (
        <Paper withBorder p="xl">
          <Stack align="center" gap="sm">
            <ThemeIcon size={48} radius="xl" variant="light" color="gray">
              <StoreIcon />
            </ThemeIcon>
            <Text fw={500}>{t('admin.empty_tenants')}</Text>
            <Button component="a" href={adminHref('/admin/tenants/new')}>
              {t('admin.new_shop')}
            </Button>
          </Stack>
        </Paper>
      ) : filtered.length === 0 ? (
        <Paper withBorder p="xl">
          <Stack align="center" gap="sm">
            <Text fw={500}>{t('admin.no_match')}</Text>
            <Button type="button" variant="default" onClick={clear}>
              {t('admin.clear_filters')}
            </Button>
          </Stack>
        </Paper>
      ) : (
        <Paper withBorder>
          <Box
            tabIndex={0}
            role="region"
            aria-label={t('admin.tenants_title')}
            style={{ overflowX: 'auto' }}
          >
            <Table fz="sm" miw={880}>
              <Table.Caption className="sr-only">
                {t('admin.tenants_title')}
              </Table.Caption>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('admin.col_name')}</Table.Th>
                  <Table.Th>{t('admin.col_status')}</Table.Th>
                  <Table.Th ta="end">{t('admin.col_devices')}</Table.Th>
                  <Table.Th>{t('admin.col_last_seen')}</Table.Th>
                  <Table.Th>{t('admin.col_setup')}</Table.Th>
                  <Table.Th>{t('admin.col_writes')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shown.map((tenant) => (
                  <Table.Tr key={tenant.id}>
                    <Table.Td>
                      <Box
                        component="a"
                        href={adminHref(`/admin/tenants/${tenant.id}`)}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <Text fw={500} truncate>
                          {tenant.display_name}
                        </Text>
                        <Text size="sm" ff="monospace" c="dimmed">
                          {tenant.slug}
                        </Text>
                      </Box>
                    </Table.Td>
                    <Table.Td>
                      <StatusBadge status={tenant.status} />
                    </Table.Td>
                    <Table.Td ta="end">
                      {formatCount(tenant.devices, lang)}
                    </Table.Td>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>
                      {tenant.last_seen_at === null
                        ? t('admin.never')
                        : formatWhen(tenant.last_seen_at, lang)}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Box
                          aria-hidden="true"
                          w={6}
                          h={6}
                          style={{
                            borderRadius: 999,
                            background: tenant.setup_completed
                              ? 'var(--mantine-color-success-6)'
                              : 'var(--mantine-color-gray-5)',
                          }}
                        />
                        <Text
                          size="sm"
                          c={
                            tenant.setup_completed
                              ? 'var(--color-success)'
                              : 'dimmed'
                          }
                        >
                          {tenant.setup_completed
                            ? t('admin.setup_done')
                            : t('admin.setup_pending')}
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <WriteMeter tenant={tenant} lang={lang} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
          <Group
            justify="space-between"
            gap="sm"
            px="md"
            py="sm"
            style={{
              borderTop: '1px solid var(--mantine-color-default-border)',
            }}
          >
            <Text size="sm" c="dimmed">
              {t('admin.page_of', {
                page: formatCount(current, lang),
                pages: formatCount(pages, lang),
              })}
            </Text>
            <Group gap="xs">
              <Button
                type="button"
                variant="default"
                size="compact-sm"
                disabled={current <= 1}
                onClick={() => setPage(current - 1)}
              >
                {t('admin.prev')}
              </Button>
              <Button
                type="button"
                variant="default"
                size="compact-sm"
                disabled={current >= pages}
                onClick={() => setPage(current + 1)}
              >
                {t('admin.next')}
              </Button>
            </Group>
          </Group>
        </Paper>
      )}
    </Stack>
  );
}

function WriteMeter({
  tenant,
  lang,
}: {
  tenant: TenantListItem;
  lang: string;
}) {
  const { t } = useTranslation();
  const budget = tenant.daily_write_budget;
  const hot = budget > 0 && tenant.today.rows_written >= budget;
  const warn = !hot && budget > 0 && tenant.today.rows_written >= 0.8 * budget;
  let tone = 'var(--color-primary)';
  if (warn) tone = 'var(--color-warning)';
  if (hot) tone = 'var(--color-danger)';
  return (
    <Box maw={112}>
      <Progress
        value={
          budget > 0
            ? Math.min(100, (tenant.today.rows_written / budget) * 100)
            : 0
        }
        size="sm"
        color={tone}
        aria-label={t('admin.writes_bar', {
          written: formatCount(tenant.today.rows_written, lang),
          budget: formatCount(budget, lang),
        })}
      />
      <Text size="sm" c="dimmed" mt={4}>
        {t('admin.writes_bar', {
          written: formatCount(tenant.today.rows_written, lang),
          budget: formatCount(budget, lang),
        })}
      </Text>
    </Box>
  );
}
