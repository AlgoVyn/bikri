import {
  Badge,
  Box,
  Button,
  Checkbox,
  FileInput,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import {
  adminErrorMessage,
  importOps,
  issueCode,
  listDevices,
  revokeDevice,
} from './api.ts';
import { formatCount, formatWhen, OPS_CHUNK } from './format.ts';
import type { DeviceInfo, IssuedCode, UnsyncedOp } from './types.ts';
import { AdminConfirm, PairingPanel, Panel } from './ui.tsx';
import { useAdminQuery } from './useAdminQuery.ts';

type Preview = {
  deviceId: string;
  name: string;
  ops: UnsyncedOp[];
};

function parseUnsynced(
  text: string,
): { tenant_id: string; device_id: string; ops: UnsyncedOp[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (body.format !== 'bikri-unsynced' || body.version !== 2) return null;
  if (
    typeof body.tenant_id !== 'string' ||
    typeof body.device_id !== 'string'
  ) {
    return null;
  }
  if (!Array.isArray(body.ops) || body.ops.length === 0) return null;
  const ops: UnsyncedOp[] = [];
  for (const item of body.ops) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return null;
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.op_id !== 'string' ||
      typeof row.tx_id !== 'string' ||
      typeof row.tbl !== 'string' ||
      typeof row.kind !== 'string'
    ) {
      return null;
    }
    const op: UnsyncedOp = {
      op_id: row.op_id,
      tx_id: row.tx_id,
      tbl: row.tbl,
      kind: row.kind,
    };
    if (row.row !== undefined) {
      if (
        row.row === null ||
        typeof row.row !== 'object' ||
        Array.isArray(row.row)
      ) {
        return null;
      }
      op.row = row.row as Record<string, unknown>;
    }
    if (row.row_id !== undefined) {
      if (typeof row.row_id !== 'string') return null;
      op.row_id = row.row_id;
    }
    if (row.base_rev !== undefined) {
      if (typeof row.base_rev !== 'number') return null;
      op.base_rev = row.base_rev;
    }
    if (row.changed_fields !== undefined) {
      if (!Array.isArray(row.changed_fields)) return null;
      const fields: string[] = [];
      for (const field of row.changed_fields) {
        if (typeof field !== 'string') return null;
        fields.push(field);
      }
      op.changed_fields = fields;
    }
    if (row.updated_by !== undefined) {
      if (row.updated_by !== null && typeof row.updated_by !== 'string')
        return null;
      op.updated_by = row.updated_by;
    }
    ops.push(op);
  }
  return { tenant_id: body.tenant_id, device_id: body.device_id, ops };
}

export function DevicesTab({
  tenantId,
  shopName,
}: {
  tenantId: string;
  shopName: string;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const query = useAdminQuery(`devices:${tenantId}`, () =>
    listDevices(tenantId),
  );
  const [name, setName] = useState('');
  const [admin, setAdmin] = useState(false);
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
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
  const devices = query.data.devices;

  return (
    <Stack gap="md">
      <Panel
        title={t('admin.issue_code')}
        description={t('admin.issue_code_hint')}
      >
        <Box
          component="form"
          onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const deviceName = name.trim();
            if (deviceName.length < 1 || pending) return;
            setPending(true);
            void issueCode(tenantId, deviceName, admin)
              .then((code) => {
                setIssued(code);
                setName('');
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
        >
          <Group align="flex-end" gap="sm" wrap="wrap">
            <TextInput
              id="device-name"
              label={t('admin.device_name')}
              value={name}
              maxLength={40}
              required
              autoComplete="off"
              onChange={(event) => setName(event.currentTarget.value)}
              style={{ flex: '1 1 14rem', minWidth: 0 }}
            />
            <Checkbox
              id="device-admin"
              label={t('admin.grants_admin')}
              checked={admin}
              onChange={(event) => setAdmin(event.currentTarget.checked)}
              mb={10}
            />
            <Button
              type="submit"
              disabled={pending || name.trim() === ''}
              loading={pending}
            >
              {t('admin.issue')}
            </Button>
          </Group>
        </Box>
      </Panel>

      {issued !== null ? (
        <PairingPanel
          code={issued.code}
          link={issued.link}
          expiresAt={issued.expires_at}
          shopName={shopName}
        />
      ) : null}

      <Panel
        title={t('admin.tab_devices')}
        description={t('admin.devices_count', {
          count: formatCount(devices.length, lang),
        })}
        bodyClassName="p-0"
      >
        {devices.length === 0 ? (
          <p className="p-4 text-small text-text-muted">
            {t('admin.devices_empty')}
          </p>
        ) : (
          <Box
            tabIndex={0}
            role="region"
            aria-label={t('admin.tab_devices')}
            style={{ overflowX: 'auto' }}
          >
            <Table fz="sm" miw={860}>
              <Table.Caption className="sr-only">
                {t('admin.tab_devices')}
              </Table.Caption>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('admin.col_name')}</Table.Th>
                  <Table.Th>{t('admin.col_kind')}</Table.Th>
                  <Table.Th>{t('admin.col_last_seen')}</Table.Th>
                  <Table.Th ta="end">{t('admin.col_pending')}</Table.Th>
                  <Table.Th>{t('admin.col_ro_seen')}</Table.Th>
                  <Table.Th>{t('admin.col_status')}</Table.Th>
                  <Table.Th>{t('admin.revoke')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {devices.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    lang={lang}
                    onRevoke={() => {
                      setRevokeId(device.id);
                    }}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        )}
      </Panel>

      <Panel title={t('admin.import_ops')} description={t('admin.import_hint')}>
        <Stack gap="sm" maw={640}>
          <FileInput
            id="unsynced-file"
            label={t('admin.import_choose')}
            accept="application/json,.json"
            value={null}
            onChange={(file) => {
              if (file === null) return;
              void file.text().then((text) => {
                const parsed = parseUnsynced(text);
                if (parsed === null) {
                  setPreview(null);
                  toast.push(t('admin.import_bad'), 'error');
                  return;
                }
                if (parsed.tenant_id !== tenantId) {
                  setPreview(null);
                  toast.push(t('admin.import_tenant_mismatch'), 'error');
                  return;
                }
                const device = devices.find(
                  (item) => item.id === parsed.device_id,
                );
                if (device === undefined || device.revoked_at === null) {
                  setPreview(null);
                  toast.push(t('admin.import_not_revoked'), 'error');
                  return;
                }
                setPreview({
                  deviceId: parsed.device_id,
                  name: device.name,
                  ops: parsed.ops,
                });
                setProgress(null);
              });
            }}
          />
          {preview !== null ? (
            <Paper p="sm" bg="var(--color-info-subtle)">
              <Text size="sm" c="var(--color-info-subtle-ink)">
                {t('admin.import_preview', {
                  count: formatCount(preview.ops.length, lang),
                  device: preview.name,
                })}
              </Text>
            </Paper>
          ) : null}
          {progress !== null ? <Text size="sm">{progress}</Text> : null}
          <Button
            type="button"
            disabled={preview === null || pending}
            loading={pending}
            onClick={() => {
              if (preview === null) return;
              const job = preview;
              setPending(true);
              void (async () => {
                let done = 0;
                for (let i = 0; i < job.ops.length; i += OPS_CHUNK) {
                  const slice = job.ops.slice(i, i + OPS_CHUNK);
                  await importOps(tenantId, job.deviceId, slice);
                  done += slice.length;
                  setProgress(
                    t('admin.import_progress', {
                      done: formatCount(done, lang),
                      total: formatCount(job.ops.length, lang),
                    }),
                  );
                }
                toast.push(t('admin.import_done'), 'info');
                setPreview(null);
                query.reload();
              })()
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
            style={{ alignSelf: 'flex-start' }}
          >
            {t('admin.import_run')}
          </Button>
        </Stack>
      </Panel>
      <AdminConfirm
        open={revokeId !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeId(null);
        }}
        title={t('admin.revoke_title')}
        body={t('admin.revoke_body')}
        confirmLabel={t('admin.revoke')}
        onConfirm={() => {
          const id = revokeId;
          if (id === null) return;
          setPending(true);
          void revokeDevice(tenantId, id)
            .then(() => {
              toast.push(t('admin.revoked'), 'info');
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
    </Stack>
  );
}

function DeviceRow({
  device,
  lang,
  onRevoke,
}: {
  device: DeviceInfo;
  lang: string;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const revoked = device.revoked_at !== null;
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap="xs" wrap="wrap">
          <Text fw={500}>{device.name}</Text>
          {device.is_admin ? (
            <Badge variant="light" color="brand" tt="none" radius="xl">
              {t('admin.col_admin')}
            </Badge>
          ) : null}
        </Group>
        <Text size="sm" ff="monospace" c="dimmed">
          {device.device_code} · {device.branch_id}
        </Text>
      </Table.Td>
      <Table.Td>
        {t(
          device.kind === 'support' ? 'admin.kind_support' : 'admin.kind_till',
        )}
      </Table.Td>
      <Table.Td style={{ whiteSpace: 'nowrap' }}>
        {device.last_seen_at === null
          ? t('admin.never')
          : formatWhen(device.last_seen_at, lang)}
        {device.app_version !== null ? (
          <Text size="sm" ff="monospace" c="dimmed">
            v{device.app_version}
          </Text>
        ) : null}
      </Table.Td>
      <Table.Td ta="end">{formatCount(device.pending_ops, lang)}</Table.Td>
      <Table.Td style={{ whiteSpace: 'nowrap' }}>
        {device.read_only_seen_at === null
          ? '—'
          : formatWhen(device.read_only_seen_at, lang)}
      </Table.Td>
      <Table.Td>
        <Badge
          variant="light"
          color={revoked ? 'danger' : 'success'}
          tt="none"
          radius="xl"
        >
          {revoked ? t('admin.revoked') : t('admin.active_device')}
        </Badge>
      </Table.Td>
      <Table.Td>
        {revoked ? (
          <Text c="dimmed">—</Text>
        ) : (
          <Button
            type="button"
            variant="default"
            size="compact-sm"
            onClick={onRevoke}
          >
            {t('admin.revoke')}
          </Button>
        )}
      </Table.Td>
    </Table.Tr>
  );
}
