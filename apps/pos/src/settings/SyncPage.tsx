/** Settings → Sync (screens/17, T-036): status, failed ops, conflicts, Sync now. */

import { newId } from '@bikri/core';
import type { OutboxEntry, SyncedRow } from '@bikri/db';
import { Box, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudIcon } from '../components/icons.tsx';
import { getDb } from '../data/db.ts';
import { getKv } from '../data/kv.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { writeAction } from '../data/write.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { syncNow } from '../sync/engine.ts';
import { discardFailed, retryFailed } from '../sync/push.ts';
import { OwnerSigninRequired, shopRequest } from '../sync/shopApi.ts';
import { useSyncState } from '../sync/state.ts';
import { SettingsPageLayout } from './Layout.tsx';
import { shopErrorMessage, useShopAdmin } from './OwnerSignin.tsx';

export function formatWhen(
  lang: string,
  at: number | null | undefined,
): string {
  if (!at) return '—';
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK' : 'en-PK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Karachi',
  }).format(at);
}

export function SyncPage() {
  const { t, i18n } = useTranslation();
  const db = getDb();
  const { staff, role } = useCurrentStaff();
  const staffId = staff ? String(staff.id) : null;
  const { run, dialog } = useShopAdmin(db, staffId);
  const sync = useSyncState();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState<{
    usage: number;
    persisted: boolean;
  } | null>(null);
  const data = useLiveQuery(async () => {
    const [
      pending,
      failed,
      conflicts,
      device,
      lastSync,
      status,
      token,
      pullErrors,
    ] = await Promise.all([
      db.outbox.where('status').equals('pending').count(),
      db.outbox.where('status').equals('failed').toArray(),
      db.sync_conflicts.toArray(),
      deviceInfo(db),
      getKv<number | null>(db, 'last_sync_at', null),
      getKv<{ status: string } | null>(db, 'tenant_status', null),
      getKv<string | null>(db, 'device_token', null),
      getKv<{ tbl: string; id: string; message: string; at: number }[]>(
        db,
        'pull_errors',
        [],
      ),
    ]);
    return {
      pending,
      failed,
      conflicts: conflicts.filter(
        (c: SyncedRow) => c.resolution === 'needs_owner',
      ),
      device,
      lastSync,
      readOnly: status?.status === 'read_only',
      enrolled: Boolean(token),
      pullErrors,
    };
  }, [db]);

  useEffect(() => {
    void (async () => {
      const est = await navigator.storage?.estimate?.();
      const persisted = (await navigator.storage?.persisted?.()) ?? false;
      setStorage({ usage: est?.usage ?? 0, persisted });
    })();
  }, []);

  if (!data) return null;
  const owner = role === 'owner';

  const discard = async (entries: OutboxEntry[]) => {
    const seqs = entries
      .map((e) => e.seq)
      .filter((s): s is number => s !== undefined);
    await discardFailed(db, seqs);
    await writeAction(
      db,
      (w) =>
        w.insert('audit_log', {
          id: newId(w.now),
          action: 'sync_ops_discarded',
          entity: 'outbox',
          entity_id: entries[0]?.op_id ?? data.device?.id ?? 'outbox',
          before_json: JSON.stringify(
            entries.map((e) => ({
              op_id: e.op_id,
              tbl: e.tbl,
              row_id: e.row_id,
              error: e.last_error,
            })),
          ),
          after_json: null,
          device_id: data.device?.id ?? null,
          staff_id: staffId,
          created_at: w.now,
        }),
      { actor: staffId, allowReadOnly: true },
    );
  };

  const acknowledge = (id: string) =>
    run(async () => {
      if (!staffId) return;
      await shopRequest(
        db,
        staffId,
        `/conflicts/${encodeURIComponent(id)}/acknowledge`,
        { method: 'POST', json: {} },
      );
      await syncNow();
    }).catch((e) => {
      if (!(e instanceof OwnerSigninRequired)) setError(shopErrorMessage(t, e));
    });

  return (
    <SettingsPageLayout title={t('syncpage.title')} icon={<CloudIcon />}>
      <Stack gap="md" data-testid="sync-page">
        {!data.enrolled ? (
          <Text c="dimmed">{t('syncpage.not_enrolled')}</Text>
        ) : null}
        {data.pullErrors.length > 0 ? (
          <Paper role="status" p="sm" bg="var(--mantine-color-warning-subtle)">
            <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
              {t('syncpage.pull_errors', { count: data.pullErrors.length })}
            </Text>
            <Box
              component="ul"
              mt={4}
              ps="md"
              style={{ color: 'var(--mantine-color-warning-subtle-ink)' }}
            >
              {data.pullErrors.slice(-3).map((row) => (
                <Text
                  component="li"
                  size="sm"
                  key={`${row.at}-${row.tbl}-${row.id}`}
                >
                  {row.tbl} · {row.id} · {row.message}
                </Text>
              ))}
            </Box>
          </Paper>
        ) : null}
        <Paper withBorder p="md">
          <Stack gap="xs">
            <Group justify="space-between" gap="sm">
              <Text size="sm" c="dimmed">
                {t('syncpage.last_sync')}
              </Text>
              <Text size="sm">
                {formatWhen(i18n.language, sync.lastSyncAt ?? data.lastSync)}
              </Text>
            </Group>
            <Group justify="space-between" gap="sm">
              <Text size="sm" c="dimmed">
                {t('syncpage.waiting')}
              </Text>
              <Text size="sm" data-testid="sync-pending">
                {data.pending}
              </Text>
            </Group>
            <Group justify="space-between" gap="sm">
              <Text size="sm" c="dimmed">
                {t('syncpage.device')}
              </Text>
              <Text size="sm">
                {data.device
                  ? `${data.device.name} · ${data.device.code}`
                  : '—'}
              </Text>
            </Group>
            <Group justify="space-between" gap="sm">
              <Text size="sm" c="dimmed">
                {t('syncpage.storage')}
              </Text>
              <Text size="sm">
                {storage
                  ? t('syncpage.storage_value', {
                      mb: (storage.usage / 1_048_576).toFixed(1),
                      persisted: storage.persisted
                        ? t('syncpage.persisted_yes')
                        : t('syncpage.persisted_no'),
                    })
                  : '—'}
              </Text>
            </Group>
          </Stack>
        </Paper>
        {sync.phase === 'quota' && sync.quotaUntil ? (
          <Paper role="status" p="sm" bg="var(--mantine-color-warning-subtle)">
            <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
              {t('syncpage.quota', {
                time: formatWhen(i18n.language, sync.quotaUntil),
              })}
            </Text>
          </Paper>
        ) : null}
        {data.readOnly && data.pending > 0 ? (
          <Paper role="status" p="sm" bg="var(--mantine-color-warning-subtle)">
            <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
              {t('syncpage.read_only_waiting')}
            </Text>
          </Paper>
        ) : null}
        {sync.phase === 'error' && sync.error ? (
          <Text role="alert" c="danger" size="sm">
            {t('syncpage.problem', { message: sync.error })}
          </Text>
        ) : null}
        {error ? (
          <Text role="alert" c="danger" size="sm">
            {error}
          </Text>
        ) : null}
        <Button
          type="button"
          disabled={busy || !data.enrolled}
          loading={busy}
          onClick={() => {
            setBusy(true);
            void syncNow().finally(() => setBusy(false));
          }}
          style={{ alignSelf: 'flex-start' }}
        >
          {busy ? t('shell.sync_syncing') : t('syncpage.sync_now')}
        </Button>

        {data.failed.length > 0 ? (
          <Box component="section">
            <Stack gap="sm">
              <Title order={2} fz="lg">
                {t('syncpage.failed_title', { count: data.failed.length })}
              </Title>
              <Paper withBorder>
                <Box
                  component="ul"
                  style={{ listStyle: 'none', margin: 0, padding: 0 }}
                >
                  {data.failed.map((e, index) => (
                    <Box
                      component="li"
                      key={e.seq}
                      data-testid="failed-op"
                      p="sm"
                      style={{
                        borderTop:
                          index > 0
                            ? '1px solid var(--mantine-color-default-border)'
                            : undefined,
                      }}
                    >
                      <Group justify="space-between" gap="sm" wrap="wrap">
                        <Text size="sm">
                          {e.tbl} · {e.kind} ·{' '}
                          <Text component="span" c="danger" inherit>
                            {e.last_error ?? '—'}
                          </Text>
                        </Text>
                        <Group gap="xs">
                          <Button
                            type="button"
                            variant="default"
                            size="compact-sm"
                            onClick={() =>
                              void retryFailed(db, [e.seq as number])
                            }
                          >
                            {t('syncpage.retry')}
                          </Button>
                          {owner ? (
                            <Button
                              type="button"
                              color="danger"
                              size="compact-sm"
                              onClick={() => void discard([e])}
                            >
                              {t('syncpage.discard')}
                            </Button>
                          ) : null}
                        </Group>
                      </Group>
                    </Box>
                  ))}
                </Box>
              </Paper>
            </Stack>
          </Box>
        ) : null}

        <Box component="section">
          <Stack gap="sm">
            <Title order={2} fz="lg">
              {t('syncpage.conflicts_title')}
            </Title>
            {data.conflicts.length === 0 ? (
              <Text c="dimmed">{t('syncpage.no_conflicts')}</Text>
            ) : (
              <Paper withBorder>
                <Box
                  component="ul"
                  style={{ listStyle: 'none', margin: 0, padding: 0 }}
                >
                  {data.conflicts.map((c, index) => (
                    <Box
                      component="li"
                      key={String(c.id)}
                      data-testid="conflict"
                      p="sm"
                      style={{
                        borderTop:
                          index > 0
                            ? '1px solid var(--mantine-color-default-border)'
                            : undefined,
                      }}
                    >
                      <Group justify="space-between" gap="sm" wrap="wrap">
                        <Text size="sm">
                          {t(`syncpage.conflict_${String(c.kind)}`, {
                            defaultValue: String(c.kind),
                          })}{' '}
                          · {String(c.tbl)} ·{' '}
                          {formatWhen(i18n.language, Number(c.at))}
                        </Text>
                        {owner && data.device?.is_admin ? (
                          <Button
                            type="button"
                            variant="default"
                            size="compact-sm"
                            onClick={() => void acknowledge(String(c.id))}
                          >
                            {t('syncpage.acknowledge')}
                          </Button>
                        ) : null}
                      </Group>
                    </Box>
                  ))}
                </Box>
              </Paper>
            )}
          </Stack>
        </Box>
        {dialog}
      </Stack>
    </SettingsPageLayout>
  );
}
