import { Box, Button, Group, Progress, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { downloadBlob } from '../lib/download.ts';
import { adminErrorMessage } from './api.ts';
import { buildTenantExport, type ExportProgress } from './exportZip.ts';
import { barPercent, formatCount } from './format.ts';
import { Panel } from './ui.tsx';

export function ExportTab({ tenantId }: { tenantId: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [rows, setRows] = useState<ExportProgress[]>([]);
  const [pending, setPending] = useState(false);
  const lang = i18n.language;

  return (
    <Panel
      title={t('admin.tab_export')}
      description={t('admin.export_hint')}
      className="max-w-2xl"
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('admin.export_intro')}
        </Text>
        <Box>
          <Button
            type="button"
            loading={pending}
            disabled={pending}
            onClick={() => {
              setPending(true);
              setRows([]);
              void buildTenantExport(tenantId, (progress) => {
                setRows((current) => {
                  const index = current.findIndex(
                    (row) => row.tbl === progress.tbl,
                  );
                  if (index === -1) return [...current, progress];
                  const next = current.slice();
                  next[index] = progress;
                  return next;
                });
              })
                .then((built) => {
                  const blob = new Blob(
                    [built.bytes as Uint8Array<ArrayBuffer>],
                    {
                      type: 'application/zip',
                    },
                  );
                  downloadBlob(built.filename, blob);
                  toast.push(t('admin.export_done'), 'info');
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
          >
            {t('admin.export_start')}
          </Button>
        </Box>
        {rows.length > 0 ? (
          <Box
            component="ul"
            aria-live="polite"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {rows.map((row) => (
              <Box component="li" key={row.tbl} mb="sm">
                <Group justify="space-between" gap="sm" wrap="wrap">
                  <Text size="sm" fw={500}>
                    {row.tbl}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {t('admin.of_limit', {
                      value: formatCount(row.done, lang),
                      limit: formatCount(row.total, lang),
                    })}
                  </Text>
                </Group>
                <Progress
                  mt={4}
                  value={barPercent(row.done, row.total)}
                  size="sm"
                  color="brand"
                  aria-label={`${row.tbl}: ${formatCount(row.done, lang)} / ${formatCount(row.total, lang)}`}
                />
              </Box>
            ))}
          </Box>
        ) : null}
      </Stack>
    </Panel>
  );
}
