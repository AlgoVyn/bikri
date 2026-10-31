import { API_BASE } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudIcon } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import { adminErrorMessage, listBackups, readBackupManifest } from './api.ts';
import {
  formatBytes,
  formatCount,
  formatWhen,
  manifestKeyFor,
} from './format.ts';
import type { BackupManifest, BackupObject } from './types.ts';
import { StatCard } from './ui.tsx';

type Row = BackupObject & { manifest: BackupManifest | null | undefined };

function tableSum(tables: Record<string, number> | undefined): number {
  if (tables === undefined) return 0;
  return Object.values(tables).reduce((sum, n) => sum + n, 0);
}

function manifestTotals(manifest: BackupManifest | null | undefined): {
  rows: number;
  shops: number;
} {
  const tenants = manifest?.tenants;
  if (tenants === undefined) return { rows: 0, shops: 0 };
  const entries = Object.values(tenants);
  return {
    rows: entries.reduce((sum, tenant) => sum + tableSum(tenant.tables), 0),
    shops: entries.length,
  };
}

export function BackupsPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lang = i18n.language;

  useEffect(() => {
    let cancelled = false;
    void listBackups()
      .then(async (list) => {
        const sql = list.objects
          .filter((object) => object.key.endsWith('.sql.gz'))
          .sort((a, b) => b.uploaded - a.uploaded)
          .slice(0, 30);
        const keys = new Set(list.objects.map((object) => object.key));
        if (!cancelled) {
          setRows(sql.map((object) => ({ ...object, manifest: undefined })));
        }
        const filled = await Promise.all(
          sql.map(async (object) => {
            const key = manifestKeyFor(object.key);
            const manifest =
              key !== null && keys.has(key)
                ? await readBackupManifest(key)
                : null;
            return { ...object, manifest };
          }),
        );
        if (!cancelled) setRows(filled);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = adminErrorMessage(err, t('admin.err_generic'));
        setError(message);
        toast.push(message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  if (error !== null && rows === null) {
    return <Text c="dimmed">{error}</Text>;
  }
  if (rows === null)
    return <Text className="sr-only">{t('common.loading')}</Text>;

  const latest = rows[0];
  const totalBytes = rows.reduce((sum, row) => sum + row.size, 0);

  return (
    <Stack gap="lg">
      <PageHeader
        icon={<CloudIcon />}
        title={t('admin.backups_title')}
        subtitle={t('admin.backups_subtitle')}
      />

      <Paper p="md" bg="var(--color-info-subtle)">
        <Group align="flex-start" gap="sm" wrap="nowrap">
          <ThemeIcon size={36} radius="md" variant="light" color="brand">
            <CloudIcon />
          </ThemeIcon>
          <Box>
            <Text fw={500} c="var(--color-info-subtle-ink)">
              {t('admin.backups_info_title')}
            </Text>
            <Text size="sm" c="var(--color-info-subtle-ink)">
              {t('admin.backups_info_body')}
            </Text>
          </Box>
        </Group>
      </Paper>

      <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
        <StatCard
          label={t('admin.backup_latest')}
          value={
            latest === undefined
              ? t('admin.never')
              : formatWhen(latest.uploaded, lang)
          }
          hint={
            latest === undefined
              ? t('admin.backups_empty')
              : formatBytes(latest.size, lang)
          }
          compact
        />
        <StatCard
          label={t('admin.backup_count')}
          value={formatCount(rows.length, lang)}
        />
        <StatCard
          label={t('admin.backup_total')}
          value={formatBytes(totalBytes, lang)}
        />
      </SimpleGrid>

      {rows.length === 0 ? (
        <Paper withBorder p="xl">
          <Stack align="center" gap="sm">
            <ThemeIcon size={48} radius="xl" variant="light" color="gray">
              <CloudIcon />
            </ThemeIcon>
            <Text fw={500}>{t('admin.backups_empty')}</Text>
            <Text size="sm" c="dimmed" maw={420} ta="center">
              {t('admin.backups_empty_hint')}
            </Text>
          </Stack>
        </Paper>
      ) : (
        <Paper withBorder>
          <Box
            tabIndex={0}
            role="region"
            aria-label={t('admin.backups_title')}
            style={{ overflowX: 'auto' }}
          >
            <Table fz="sm" miw={760}>
              <Table.Caption className="sr-only">
                {t('admin.backups_title')}
              </Table.Caption>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('admin.col_date')}</Table.Th>
                  <Table.Th ta="end">{t('admin.col_size')}</Table.Th>
                  <Table.Th>{t('admin.col_counts')}</Table.Th>
                  <Table.Th>{t('admin.download')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr key={row.key}>
                    <Table.Td style={{ whiteSpace: 'nowrap' }}>
                      {formatWhen(row.uploaded, lang)}
                    </Table.Td>
                    <Table.Td ta="end">{formatBytes(row.size, lang)}</Table.Td>
                    <Table.Td>
                      <Counts manifest={row.manifest} />
                    </Table.Td>
                    <Table.Td>
                      <Button
                        component="a"
                        href={`${API_BASE}/admin/backups/download?key=${encodeURIComponent(row.key)}`}
                        variant="default"
                        size="compact-sm"
                      >
                        {t('admin.download')}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        </Paper>
      )}
    </Stack>
  );
}

function Counts({ manifest }: { manifest: BackupManifest | null | undefined }) {
  const { t, i18n } = useTranslation();
  if (manifest === undefined) {
    return (
      <Text size="sm" c="dimmed">
        {t('common.loading')}
      </Text>
    );
  }
  const tenants = manifest?.tenants;
  if (manifest === null || tenants === undefined) {
    return (
      <Text size="sm" c="dimmed">
        {t('admin.counts_missing')}
      </Text>
    );
  }
  const entries = Object.entries(tenants);
  if (entries.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t('admin.counts_missing')}
      </Text>
    );
  }
  const totals = manifestTotals(manifest);
  return (
    <Box component="details">
      <Text
        component="summary"
        size="sm"
        fw={500}
        c="var(--mantine-color-brand-7)"
        style={{ cursor: 'pointer' }}
      >
        {t('admin.counts_summary', {
          rows: formatCount(totals.rows, i18n.language),
          shops: formatCount(totals.shops, i18n.language),
        })}
      </Text>
      <Box component="ul" mt={4} style={{ maxHeight: 192, overflowY: 'auto' }}>
        {entries.map(([id, tenant]) => (
          <li key={id} className="tabular-nums">
            {tenant.slug ?? id}:{' '}
            {formatCount(tableSum(tenant.tables), i18n.language)}
          </li>
        ))}
      </Box>
    </Box>
  );
}
