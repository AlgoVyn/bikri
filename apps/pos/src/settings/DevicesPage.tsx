import { formatShopMoney } from '../lib/money';
/** Settings → Devices on an admin device (screens/17, T-038): codes, devices, import unsynced ops. */

import type { BikriDb } from '@bikri/db';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { DeviceIcon, UploadIcon } from '../components/icons.tsx';
import { QrCode } from '../components/QrCode.tsx';
import { getDb } from '../data/db.ts';
import { formatCode } from '../data/enrol.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { useOnline } from '../shell/TopBarParts.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { OwnerSigninRequired, shopRequest } from '../sync/shopApi.ts';
import { SettingsPageLayout } from './Layout.tsx';
import { shopErrorMessage, useShopAdmin } from './OwnerSignin.tsx';

export type ShopDevice = {
  id: string;
  name: string;
  branch_id: string;
  device_code: string;
  is_admin: boolean;
  kind: 'till' | 'support';
  enrolled_at: number;
  last_seen_at: number | null;
  app_version: string | null;
  pending_ops: number;
  oldest_pending_at: number | null;
  revoked_at: number | null;
  expires_at: number | null;
};
type CodeRow = {
  id: string;
  device_name: string;
  is_admin: boolean;
  expires_at: number;
  created_at: number;
};
type NewCode = { code: string; expires_at: number; link: string };

export type UnsyncedFile = {
  format: string;
  version: number;
  tenant_id: string;
  device_id: string;
  ops: {
    tbl: string;
    kind: string;
    created_at: number;
    row?: Record<string, unknown>;
  }[];
};

/** Validates a `bikri-unsynced-*.json` file for this shop (03 §8) and summarises it. */
export function previewUnsynced(text: string, tenantId: string) {
  let data: UnsyncedFile;
  try {
    data = JSON.parse(text) as UnsyncedFile;
  } catch {
    return { error: 'invalid' as const };
  }
  if (
    data?.format !== 'bikri-unsynced' ||
    !Array.isArray(data.ops) ||
    typeof data.device_id !== 'string'
  )
    return { error: 'invalid' as const };
  if (data.tenant_id !== tenantId) return { error: 'other_shop' as const };
  const times = data.ops
    .map((o) => Number(o.created_at))
    .filter(Number.isFinite);
  let sales = 0;
  let payments = 0;
  for (const o of data.ops) {
    if (o.tbl === 'sales' && o.kind === 'insert')
      sales += Number(o.row?.total ?? 0);
    if (o.tbl === 'payments' && o.kind === 'insert')
      payments += Number(o.row?.amount ?? 0);
  }
  return {
    file: data,
    count: data.ops.length,
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
    sales,
    payments,
  };
}

export const IMPORT_CHUNK = 200;

export async function importUnsynced(
  db: BikriDb,
  staffId: string,
  file: UnsyncedFile,
  onProgress?: (done: number) => void,
) {
  let applied = 0;
  let rejected = 0;
  for (let i = 0; i < file.ops.length; i += IMPORT_CHUNK) {
    const ops = file.ops.slice(i, i + IMPORT_CHUNK);
    const res = await shopRequest<{ results: { result: string }[] }>(
      db,
      staffId,
      '/import-ops',
      {
        method: 'POST',
        json: { device_id: file.device_id, ops },
      },
    );
    for (const r of res.results ?? []) {
      if (r.result === 'rejected') rejected += 1;
      else applied += 1;
    }
    onProgress?.(Math.min(file.ops.length, i + IMPORT_CHUNK));
  }
  return { applied, rejected };
}

function timeText(lang: string, at: number | null): string {
  if (!at) return '—';
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK' : 'en-PK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Karachi',
  }).format(at);
}

export function DevicesPage() {
  const { t, i18n } = useTranslation();
  const db = getDb();
  const online = useOnline();
  const { staff, role, support } = useCurrentStaff();
  const staffId = staff ? String(staff.id) : null;
  const { run, dialog } = useShopAdmin(db, staffId);
  const me = useLiveQuery(() => deviceInfo(db), [db]);
  const enrolled = useLiveQuery(
    async () => Boolean((await db.kv.get('device_token'))?.value),
    [db],
  );
  const branches =
    useLiveQuery(
      async () => (await db.branches.toArray()).filter((b) => !b.deleted_at),
      [db],
    ) ?? [];
  const localDevices = useLiveQuery(() => db.devices.toArray(), [db]) ?? [];
  const [devices, setDevices] = useState<ShopDevice[] | null>(null);
  const [codes, setCodes] = useState<CodeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<NewCode | null>(null);
  const [now, setNow] = useState(Date.now());
  const [form, setForm] = useState({ name: '', branch: '', admin: false });
  const [confirmRevoke, setConfirmRevoke] = useState<ShopDevice | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [fileName, setFileName] = useState<string | null>(null);
  const [importState, setImportState] = useState<
    | null
    | {
        kind: 'preview';
        p: Exclude<ReturnType<typeof previewUnsynced>, { error: string }>;
      }
    | { kind: 'running'; done: number; total: number }
    | { kind: 'done'; applied: number; rejected: number }
  >(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const guard = useCallback(
    async (fn: () => Promise<void>) => {
      setError(null);
      try {
        await run(fn);
      } catch (e) {
        if (!(e instanceof OwnerSigninRequired))
          setError(shopErrorMessage(t, e));
      }
    },
    [run, t],
  );

  const load = useCallback(async () => {
    if (!staffId) return;
    const [d, c] = await Promise.all([
      shopRequest<{ devices: ShopDevice[] }>(db, staffId, '/devices'),
      shopRequest<{ codes: CodeRow[] }>(db, staffId, '/enrolment-codes'),
    ]);
    setDevices(d.devices);
    setCodes(c.codes);
  }, [db, staffId]);

  useEffect(() => {
    if (online && enrolled && staffId && me?.is_admin && role === 'owner')
      void guard(load);
  }, [online, enrolled, staffId, me?.is_admin, role, guard, load]);

  if (support) {
    return (
      <SettingsPageLayout title={t('devices.title')} icon={<DeviceIcon />}>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('devices.support_view')}
          </Text>
          <Paper withBorder>
            <Box
              component="ul"
              style={{ listStyle: 'none', margin: 0, padding: 0 }}
            >
              {localDevices.map((device, index) => (
                <Box
                  component="li"
                  key={String(device.id)}
                  p="sm"
                  style={{
                    borderTop:
                      index > 0
                        ? '1px solid var(--mantine-color-default-border)'
                        : undefined,
                  }}
                >
                  <Group justify="space-between" gap="sm" wrap="wrap">
                    <Text fw={500}>{String(device.name)}</Text>
                    <Text size="sm" c="dimmed">
                      {String(device.device_code)}
                      {' · '}
                      {String(
                        branches.find((b) => b.id === device.branch_id)?.name ??
                          '—',
                      )}
                      {device.revoked_at ? ` · ${t('devices.revoked')}` : ''}
                    </Text>
                  </Group>
                </Box>
              ))}
            </Box>
          </Paper>
        </Stack>
      </SettingsPageLayout>
    );
  }
  if (!me?.is_admin || role !== 'owner')
    return (
      <SettingsPageLayout title={t('devices.title')} icon={<DeviceIcon />}>
        <Text p="lg" c="dimmed">
          {t('devices.admin_only')}
        </Text>
      </SettingsPageLayout>
    );
  if (!online)
    return (
      <SettingsPageLayout title={t('devices.title')} icon={<DeviceIcon />}>
        <Text p="lg" c="dimmed">
          {t('devices.online_only')}
        </Text>
      </SettingsPageLayout>
    );

  const branchName = (id: string) =>
    branches.find((b) => b.id === id)?.name ?? '—';
  const branchId = form.branch || String(me.branch_id);

  return (
    <SettingsPageLayout title={t('devices.title')} icon={<DeviceIcon />}>
      <Stack gap="md">
        {error ? (
          <Text role="alert" c="danger">
            {error}
          </Text>
        ) : null}
        {enrolled === false ? (
          <Text size="sm" c="dimmed">
            {t('owner.not_enrolled')}
          </Text>
        ) : null}

        <Paper withBorder p="lg">
          <Stack gap="sm">
            <Title order={2} fz="lg">
              {t('devices.add_title')}
            </Title>
            <Box
              component="form"
              onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (!staffId || !form.name.trim()) return;
                void guard(async () => {
                  const res = await shopRequest<NewCode>(
                    db,
                    staffId,
                    '/enrolment-codes',
                    {
                      method: 'POST',
                      json: {
                        device_name: form.name.trim(),
                        branch_id: branchId,
                        is_admin: form.admin,
                      },
                    },
                  );
                  setFresh(res);
                  setForm({ name: '', branch: '', admin: false });
                  await load();
                });
              }}
            >
              <Group align="flex-end" gap="sm" wrap="wrap">
                <TextInput
                  label={t('devices.name')}
                  maxLength={40}
                  required
                  value={form.name}
                  onChange={(event) =>
                    setForm({ ...form, name: event.currentTarget.value })
                  }
                  style={{ flex: '1 1 12rem', minWidth: 0 }}
                />
                <NativeSelect
                  label={t('devices.branch')}
                  value={branchId}
                  onChange={(event) =>
                    setForm({ ...form, branch: event.currentTarget.value })
                  }
                  data={branches.map((b) => ({
                    value: String(b.id),
                    label: String(b.name),
                  }))}
                />
                <Checkbox
                  label={t('devices.can_manage')}
                  checked={form.admin}
                  onChange={(event) =>
                    setForm({ ...form, admin: event.currentTarget.checked })
                  }
                  mb={10}
                />
                <Button type="submit">{t('devices.make_code')}</Button>
              </Group>
            </Box>
            {fresh && fresh.expires_at > now ? (
              <Group gap="md" align="center" data-testid="new-code" wrap="wrap">
                <QrCode value={fresh.link} label={t('devices.qr_label')} />
                <Stack gap={4}>
                  <Text
                    ff="monospace"
                    fz={28}
                    fw={600}
                    style={{ letterSpacing: '0.12em' }}
                  >
                    {formatCode(fresh.code)}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {t('devices.code_expires', {
                      time: `${Math.floor((fresh.expires_at - now) / 60000)}:${String(Math.floor(((fresh.expires_at - now) % 60000) / 1000)).padStart(2, '0')}`,
                    })}
                  </Text>
                </Stack>
              </Group>
            ) : null}
            {codes.length > 0 ? (
              <Box>
                <Text fw={500} mb={4}>
                  {t('devices.unused_codes')}
                </Text>
                <Box
                  component="ul"
                  style={{ listStyle: 'none', margin: 0, padding: 0 }}
                >
                  {codes.map((c, index) => (
                    <Box
                      component="li"
                      key={c.id}
                      py="xs"
                      style={{
                        borderTop:
                          index > 0
                            ? '1px solid var(--mantine-color-default-border)'
                            : undefined,
                      }}
                    >
                      <Group justify="space-between" gap="sm" wrap="wrap">
                        <Text size="sm">
                          {c.device_name}
                          {c.is_admin ? ` · ${t('devices.admin')}` : ''} ·{' '}
                          {timeText(i18n.language, c.expires_at)}
                        </Text>
                        <Button
                          type="button"
                          variant="default"
                          size="compact-sm"
                          onClick={() =>
                            void guard(async () => {
                              if (!staffId) return;
                              await shopRequest(
                                db,
                                staffId,
                                `/enrolment-codes/${encodeURIComponent(c.id)}`,
                                { method: 'DELETE' },
                              );
                              if (fresh) setFresh(null);
                              await load();
                            })
                          }
                        >
                          {t('common.cancel')}
                        </Button>
                      </Group>
                    </Box>
                  ))}
                </Box>
              </Box>
            ) : null}
          </Stack>
        </Paper>

        <Box component="section">
          <Stack gap="sm">
            <Group justify="space-between" gap="sm">
              <Title order={2} fz="lg">
                {t('devices.list_title')}
              </Title>
              <Button
                type="button"
                variant="default"
                onClick={() => void guard(load)}
              >
                {t('devices.load')}
              </Button>
            </Group>
            {devices === null ? (
              <Button
                type="button"
                variant="default"
                onClick={() => void guard(load)}
                style={{ alignSelf: 'flex-start' }}
              >
                {t('devices.load')}
              </Button>
            ) : (
              <Paper withBorder data-testid="device-list">
                <Box
                  component="ul"
                  style={{ listStyle: 'none', margin: 0, padding: 0 }}
                >
                  {devices.map((d, index) => (
                    <Box
                      component="li"
                      key={d.id}
                      p="sm"
                      style={{
                        borderTop:
                          index > 0
                            ? '1px solid var(--mantine-color-default-border)'
                            : undefined,
                      }}
                    >
                      <Stack gap="xs">
                        <Group gap="xs" wrap="wrap" align="center">
                          {renaming?.id === d.id ? (
                            <Box
                              component="form"
                              onSubmit={(
                                event: React.FormEvent<HTMLFormElement>,
                              ) => {
                                event.preventDefault();
                                void guard(async () => {
                                  if (!staffId) return;
                                  await shopRequest(
                                    db,
                                    staffId,
                                    `/devices/${d.id}`,
                                    {
                                      method: 'PATCH',
                                      json: { name: renaming.name.trim() },
                                    },
                                  );
                                  setRenaming(null);
                                  await load();
                                });
                              }}
                            >
                              <Group gap="xs">
                                <TextInput
                                  maxLength={40}
                                  value={renaming.name}
                                  onChange={(event) =>
                                    setRenaming({
                                      id: d.id,
                                      name: event.currentTarget.value,
                                    })
                                  }
                                  aria-label={t('devices.name')}
                                />
                                <Button type="submit">
                                  {t('devices.save')}
                                </Button>
                              </Group>
                            </Box>
                          ) : (
                            <Text fw={500}>{d.name}</Text>
                          )}
                          <Badge variant="light" color="gray" tt="none">
                            {d.device_code}
                          </Badge>
                          {d.is_admin ? (
                            <Badge variant="light" color="brand" tt="none">
                              {t('devices.admin')}
                            </Badge>
                          ) : null}
                          {d.kind === 'support' ? (
                            <Badge variant="light" color="warning" tt="none">
                              {t('devices.support', {
                                time: timeText(i18n.language, d.expires_at),
                              })}
                            </Badge>
                          ) : null}
                          {d.id === me.id ? (
                            <Text size="sm" c="dimmed">
                              {t('devices.this_device')}
                            </Text>
                          ) : null}
                          {d.revoked_at ? (
                            <Text size="sm" c="danger">
                              {t('devices.revoked')}
                            </Text>
                          ) : null}
                        </Group>
                        <Text size="sm" c="dimmed">
                          {t('devices.meta', {
                            branch: branchName(d.branch_id),
                            seen: timeText(i18n.language, d.last_seen_at),
                            version: d.app_version ?? '—',
                            pending: d.pending_ops,
                          })}
                        </Text>
                        {d.revoked_at ? null : (
                          <Group gap="xs" wrap="wrap">
                            {d.kind === 'till' ? (
                              <>
                                <Button
                                  type="button"
                                  variant="default"
                                  size="compact-sm"
                                  onClick={() =>
                                    setRenaming({ id: d.id, name: d.name })
                                  }
                                >
                                  {t('devices.rename')}
                                </Button>
                                {branches.length > 1 ? (
                                  <NativeSelect
                                    aria-label={t('devices.move')}
                                    value={d.branch_id}
                                    onChange={(event) =>
                                      void guard(async () => {
                                        if (!staffId) return;
                                        await shopRequest(
                                          db,
                                          staffId,
                                          `/devices/${d.id}`,
                                          {
                                            method: 'PATCH',
                                            json: {
                                              branch_id:
                                                event.currentTarget.value,
                                            },
                                          },
                                        );
                                        await load();
                                      })
                                    }
                                    data={branches.map((b) => ({
                                      value: String(b.id),
                                      label: String(b.name),
                                    }))}
                                    w={160}
                                  />
                                ) : null}
                                <Button
                                  type="button"
                                  variant="default"
                                  size="compact-sm"
                                  onClick={() =>
                                    void guard(async () => {
                                      if (!staffId) return;
                                      await shopRequest(
                                        db,
                                        staffId,
                                        `/devices/${d.id}`,
                                        {
                                          method: 'PATCH',
                                          json: { is_admin: !d.is_admin },
                                        },
                                      );
                                      await load();
                                    })
                                  }
                                >
                                  {d.is_admin
                                    ? t('devices.remove_admin')
                                    : t('devices.make_admin')}
                                </Button>
                              </>
                            ) : null}
                            <Button
                              type="button"
                              color="danger"
                              size="compact-sm"
                              onClick={() => setConfirmRevoke(d)}
                            >
                              {t('devices.revoke')}
                            </Button>
                          </Group>
                        )}
                      </Stack>
                    </Box>
                  ))}
                </Box>
              </Paper>
            )}
          </Stack>
        </Box>

        <Paper withBorder p="lg">
          <Stack gap="sm">
            <Title order={2} fz="lg">
              {t('devices.import_title')}
            </Title>
            <Text size="sm" c="dimmed">
              {t('devices.import_help')}
            </Text>
            <Group gap="sm" align="center">
              <input
                id="unsynced-file"
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => {
                  const f = event.target.files?.[0];
                  if (!f) return;
                  setFileName(f.name);
                  void f.text().then((text) => {
                    const p = previewUnsynced(text, db.tenantId);
                    if ('error' in p) {
                      setImportState(null);
                      setError(
                        p.error === 'other_shop'
                          ? t('devices.import_other_shop')
                          : t('devices.import_invalid'),
                      );
                    } else {
                      setError(null);
                      setImportState({ kind: 'preview', p });
                    }
                  });
                }}
              />
              <Button
                component="label"
                htmlFor="unsynced-file"
                variant="default"
                leftSection={<UploadIcon />}
              >
                {t('devices.import_choose')}
              </Button>
              <Text size="sm" c="dimmed" aria-live="polite">
                {fileName ?? t('devices.import_no_file')}
              </Text>
            </Group>
            {importState?.kind === 'preview' ? (
              <Stack gap="sm" data-testid="import-preview">
                <Text>
                  {t('devices.import_preview', {
                    count: importState.p.count,
                    from: timeText(i18n.language, importState.p.from),
                    to: timeText(i18n.language, importState.p.to),
                    sales: formatShopMoney(importState.p.sales),
                    payments: formatShopMoney(importState.p.payments),
                  })}
                </Text>
                <Button
                  type="button"
                  onClick={() => {
                    const file = importState.p.file;
                    void guard(async () => {
                      if (!staffId) return;
                      setImportState({
                        kind: 'running',
                        done: 0,
                        total: file.ops.length,
                      });
                      const out = await importUnsynced(
                        db,
                        staffId,
                        file,
                        (done) =>
                          setImportState({
                            kind: 'running',
                            done,
                            total: file.ops.length,
                          }),
                      );
                      setImportState({ kind: 'done', ...out });
                    });
                  }}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {t('devices.import_go')}
                </Button>
              </Stack>
            ) : null}
            {importState?.kind === 'running' ? (
              <Text role="status">
                {t('devices.import_running', {
                  done: importState.done,
                  total: importState.total,
                })}
              </Text>
            ) : null}
            {importState?.kind === 'done' ? (
              <Text role="status">
                {t('devices.import_done', {
                  applied: importState.applied,
                  rejected: importState.rejected,
                })}
              </Text>
            ) : null}
          </Stack>
        </Paper>

        <ConfirmDialog
          open={confirmRevoke !== null}
          onOpenChange={(o) => (o ? undefined : setConfirmRevoke(null))}
          title={t('devices.revoke_title', { name: confirmRevoke?.name ?? '' })}
          body={t('devices.revoke_body')}
          confirmLabel={t('devices.revoke')}
          onConfirm={() => {
            const d = confirmRevoke;
            if (!d) return;
            void guard(async () => {
              if (!staffId) return;
              await shopRequest(db, staffId, `/devices/${d.id}/revoke`, {
                method: 'POST',
                json: {},
              });
              await load();
            });
          }}
        />
        {dialog}
      </Stack>
    </SettingsPageLayout>
  );
}
