import {
  Avatar,
  Badge,
  Box,
  Group,
  Menu,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LockIcon, UserIcon } from '../components/icons.tsx';
import { getDb } from '../data/db.ts';
import { tenantInfo } from '../data/localTenant.ts';
import { unresolvedFailedCount } from '../data/printJobs.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useSession } from '../state/session.ts';
import { useSyncState } from '../sync/state.ts';

/** The shop's own name (shop row, else the tenant's display name). */
export function useShopName(): string | null {
  return (
    useLiveQuery(async () => {
      const db = getDb();
      const shop = (await db.shop.toArray()).find((s) => !s.deleted_at);
      if (shop?.name) return String(shop.name);
      return (await tenantInfo(db))?.display_name ?? null;
    }, []) ?? null
  );
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

const dot = (
  <Box
    aria-hidden="true"
    w={6}
    h={6}
    style={{ borderRadius: 999, background: 'currentColor' }}
  />
);

/** Rail badge (03 §7): synced, pending, offline, error, outdated, downloading, read-only, quota. */
export function SyncBadge({ compact = false }: { compact?: boolean } = {}) {
  const { t } = useTranslation();
  const online = useOnline();
  const sync = useSyncState();
  const counts = useLiveQuery(async () => {
    const db = getDb();
    const [pending, failed, status, lastSync] = await Promise.all([
      db.outbox.where('status').equals('pending').count(),
      db.outbox.where('status').equals('failed').count(),
      db.kv.get('tenant_status'),
      db.kv.get('last_sync_at'),
    ]);
    return {
      pending,
      failed,
      readOnly:
        (status?.value as { status?: string } | undefined)?.status ===
        'read_only',
      lastSync: (lastSync?.value as number | undefined) ?? null,
    };
  }, []);
  if (!counts) return null;
  const ago = (at: number | null) =>
    at
      ? t('shell.sync_ago', {
          minutes: Math.max(0, Math.round((Date.now() - at) / 60_000)),
        })
      : t('shell.sync_never');
  let color = 'success';
  let label = t('shell.sync_synced');
  let detail = t('shell.sync_detail_synced', {
    ago: ago(counts.lastSync),
    count: counts.pending,
  });
  let state = 'synced';
  if (sync.phase === 'downloading') {
    const pct =
      sync.progress && sync.progress.total > 0
        ? Math.round((sync.progress.done / sync.progress.total) * 100)
        : 0;
    state = 'downloading';
    color = 'brand';
    label = t('shell.sync_downloading', { pct });
    detail = label;
  } else if (sync.phase === 'outdated') {
    state = 'outdated';
    color = 'brand';
    label = t('shell.sync_outdated');
    detail = label;
  } else if (counts.readOnly) {
    state = 'read-only';
    color = 'gray';
    label = t('shell.sync_read_only');
    detail = t('shell.sync_detail_read_only', { count: counts.pending });
  } else if (!online || sync.phase === 'offline') {
    state = 'offline';
    color = 'gray';
    label = t('shell.sync_offline');
    detail = t('shell.sync_detail_offline', { count: counts.pending });
  } else if (sync.phase === 'suspended') {
    state = 'paused';
    color = 'warning';
    label = t('shell.sync_paused');
    detail = t('shell.sync_detail_paused', { count: counts.pending });
  } else if (sync.phase === 'quota') {
    state = 'quota';
    color = 'warning';
    label = t('shell.sync_quota');
    detail = label;
  } else if (counts.failed > 0 || sync.phase === 'error') {
    state = 'error';
    color = 'danger';
    label = t('shell.sync_problem');
    detail = t('shell.sync_detail_error', {
      message:
        sync.error ?? t('shell.sync_failed_ops', { count: counts.failed }),
    });
  } else if (counts.pending > 0) {
    state = 'pending';
    color = 'gray';
    label = t('shell.sync_waiting', { count: counts.pending });
    detail = t('shell.sync_detail_pending', {
      count: counts.pending,
      ago: ago(counts.lastSync),
    });
  } else if (sync.phase === 'syncing') {
    label = t('shell.sync_syncing');
  }
  return (
    <Tooltip label={detail} withArrow openDelay={300}>
      <UnstyledButton
        component={Link}
        to="/settings/sync"
        data-testid={compact ? 'sync-badge-menu' : 'sync-badge'}
        data-state={state}
        aria-label={detail === label ? label : `${label}. ${detail}`}
      >
        <Badge
          variant="light"
          color={color}
          size={compact ? 'md' : 'lg'}
          leftSection={dot}
          radius="xl"
          styles={{
            root: {
              height: 32,
              maxWidth: compact ? 220 : 190,
              textTransform: 'none',
              fontWeight: 600,
            },
            label: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }}
        >
          {label}
        </Badge>
      </UnstyledButton>
    </Tooltip>
  );
}

/** Printer status pill: green when set up, red when this device has no printer (T-020). */
export function PrinterDot({ compact = false }: { compact?: boolean } = {}) {
  const { t } = useTranslation();
  const data = useLiveQuery(async () => {
    const db = getDb();
    return {
      printer: (await db.kv.get('printer'))?.value ?? null,
      failed: await unresolvedFailedCount(db),
    };
  }, []);
  const printer = data?.printer ?? null;
  const failed = data?.failed ?? 0;
  const loading = data === undefined;
  const detail = failed
    ? t('shell.printer_failed')
    : printer
      ? t('shell.printer_ready')
      : t('shell.printer_none');
  const visible = failed ? detail : printer ? detail : t('shell.printer_no');
  const color = loading
    ? 'gray'
    : failed
      ? 'danger'
      : printer
        ? 'success'
        : 'gray';
  return (
    <Tooltip label={detail} withArrow openDelay={300}>
      <UnstyledButton
        component={Link}
        to="/settings/printer"
        data-testid={compact ? 'printer-dot-menu' : 'printer-dot'}
        aria-label={visible === detail ? detail : `${visible}. ${detail}`}
        className={
          loading
            ? 'bg-surface-2 text-text-muted'
            : failed
              ? 'bg-danger-subtle text-danger-subtle-ink'
              : printer
                ? 'bg-success-subtle text-success-subtle-ink'
                : 'bg-surface-2 text-text-muted'
        }
      >
        <Badge
          variant="light"
          color={color}
          size={compact ? 'md' : 'lg'}
          leftSection={dot}
          radius="xl"
          styles={{
            root: {
              height: 32,
              maxWidth: compact ? 220 : 170,
              textTransform: 'none',
              fontWeight: 600,
            },
            label: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }}
        >
          {visible}
        </Badge>
      </UnstyledButton>
    </Tooltip>
  );
}

/** Staff avatar with name, role and Lock (T-035; unlocking another profile switches user). */
export function StaffMenu() {
  const { t } = useTranslation();
  const { staff, role, support } = useCurrentStaff();
  const lock = useSession((s) => s.lock);
  const name = support ? t('lock.support_profile') : String(staff?.name ?? '');
  const initial = name.slice(0, 1).toUpperCase() || '?';
  return (
    <Menu position="bottom-end" width={250} shadow="lg" radius="md">
      <Menu.Target>
        <UnstyledButton
          aria-label={t('shell.staff_menu')}
          style={{ display: 'flex', alignItems: 'center' }}
        >
          <Avatar color="brand" radius="xl" size={36} variant="filled">
            {initial}
          </Avatar>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          <Group gap="sm" wrap="nowrap">
            <Avatar color="brand" variant="light" radius="xl" size={32}>
              <UserIcon />
            </Avatar>
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Group gap={4} wrap="nowrap" data-testid="staff-menu-user">
                <UserIcon />
                <Text size="sm" fw={600} truncate>
                  {name}
                </Text>
              </Group>
              <Text size="xs" c="dimmed" truncate>
                {support ? t('lock.support_profile') : t(`shell.role_${role}`)}
              </Text>
            </Stack>
          </Group>
        </Menu.Label>
        <Box hiddenFrom="lg" px="xs" pb="xs">
          <Stack gap={6} align="flex-start">
            <SyncBadge compact />
            <PrinterDot compact />
          </Stack>
        </Box>
        <Menu.Divider hiddenFrom="lg" />
        <Menu.Item
          leftSection={<LockIcon />}
          onClick={() => lock()}
          rightSection={
            <Text size="xs" c="dimmed">
              Ctrl+L
            </Text>
          }
        >
          {t('shell.lock')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
