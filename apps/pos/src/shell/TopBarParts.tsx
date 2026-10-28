import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDb } from '../data/db.ts';
import { tenantInfo } from '../data/localTenant.ts';
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

/** Rail badge (03 §7): synced, pending, offline, error, outdated, downloading, read-only, quota. */
export function SyncBadge() {
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
  let tone = 'bg-success-subtle text-success-subtle-ink';
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
    tone = 'bg-info-subtle text-info-subtle-ink';
    label = t('shell.sync_downloading', { pct });
    detail = label;
  } else if (sync.phase === 'outdated') {
    state = 'outdated';
    tone = 'bg-info-subtle text-info-subtle-ink';
    label = t('shell.sync_outdated');
    detail = label;
  } else if (counts.readOnly) {
    state = 'read-only';
    tone = 'bg-surface-2 text-text-muted';
    label = t('shell.sync_read_only');
    detail = t('shell.sync_detail_read_only', { count: counts.pending });
  } else if (!online || sync.phase === 'offline') {
    state = 'offline';
    tone = 'bg-surface-2 text-text-muted';
    label = t('shell.sync_offline');
    detail = t('shell.sync_detail_offline', { count: counts.pending });
  } else if (sync.phase === 'suspended') {
    // 13 §7.2: a suspended shop keeps selling offline; ops stay on the device.
    state = 'paused';
    tone = 'bg-warning-subtle text-warning-subtle-ink';
    label = t('shell.sync_paused');
    detail = t('shell.sync_detail_paused', { count: counts.pending });
  } else if (sync.phase === 'quota') {
    state = 'quota';
    tone = 'bg-warning-subtle text-warning-subtle-ink';
    label = t('shell.sync_quota');
    detail = label;
  } else if (counts.failed > 0 || sync.phase === 'error') {
    state = 'error';
    tone = 'bg-danger-subtle text-danger-subtle-ink';
    label = t('shell.sync_problem');
    detail = t('shell.sync_detail_error', {
      message:
        sync.error ?? t('shell.sync_failed_ops', { count: counts.failed }),
    });
  } else if (counts.pending > 0) {
    state = 'pending';
    tone = 'bg-warning-subtle text-warning-subtle-ink';
    label = t('shell.sync_waiting', { count: counts.pending });
    detail = t('shell.sync_detail_pending', {
      count: counts.pending,
      ago: ago(counts.lastSync),
    });
  } else if (sync.phase === 'syncing') {
    label = t('shell.sync_syncing');
  }
  return (
    <Link
      to="/settings/sync"
      data-testid="sync-badge"
      data-state={state}
      // axe label-content-name-mismatch: the accessible name starts with the visible text.
      aria-label={detail === label ? label : `${label}. ${detail}`}
      title={detail}
      className={`inline-flex h-8 items-center gap-1 rounded-full px-2 text-small ${tone}`}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      <span className="max-lg:hidden">{label}</span>
      {state === 'pending' ? (
        <bdi className="lg:hidden" aria-hidden="true">
          {counts.pending}
        </bdi>
      ) : null}
    </Link>
  );
}

/** Printer status dot; the real connection state comes with printer setup (T-020). */
export function PrinterDot() {
  const { t } = useTranslation();
  const printer = useLiveQuery(
    async () => (await getDb().kv.get('printer'))?.value ?? null,
    [],
  );
  const label = printer ? t('shell.printer_ready') : t('shell.printer_none');
  return (
    <span
      role="img"
      data-testid="printer-dot"
      aria-label={label}
      title={label}
      className="flex size-8 items-center justify-center"
    >
      <span
        className={`size-3 rounded-full ${printer ? 'bg-success' : 'bg-border-strong'}`}
      />
    </span>
  );
}

/** Staff avatar with name, role and Lock (T-035; unlocking another profile switches user). */
export function StaffMenu() {
  const { t } = useTranslation();
  const { staff, role, support } = useCurrentStaff();
  const lock = useSession((s) => s.lock);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const name = support ? t('lock.support_profile') : String(staff?.name ?? '');
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t('shell.staff_menu')}
        aria-expanded={open}
        aria-controls={menuId}
        className="flex size-11 items-center justify-center"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <span className="flex size-9 items-center justify-center rounded-full bg-primary font-semibold text-primary-ink ring-2 ring-primary-subtle">
          {name.slice(0, 1).toUpperCase() || '?'}
        </span>
      </button>
      {open ? (
        <div
          id={menuId}
          className="absolute end-0 top-12 z-40 w-56 rounded-card border border-border bg-surface p-3 shadow-lg"
        >
          <p className="font-medium">{name}</p>
          <p className="text-small text-text-muted">
            {support ? t('lock.support_profile') : t(`shell.role_${role}`)}
          </p>
          <button
            type="button"
            title={`${t('shell.lock')} (Ctrl+L)`}
            className="mt-2 flex min-h-11 w-full items-center rounded-control px-2 text-start hover:bg-surface-2"
            onClick={() => {
              setOpen(false);
              lock();
            }}
          >
            {t('shell.lock')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
