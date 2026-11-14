import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronRightIcon,
  InfoIcon,
  LockIcon,
  PrinterIcon,
  SearchIcon,
  SettingsIcon,
  StoreIcon,
  UserIcon,
} from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { LanguageMenu } from '../components/LanguageSelect.tsx';
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

/** Sync state, pending/failed counts and the user-facing label (03 §7). */
export function useSyncStatus() {
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
    label = t('shell.sync_downloading', { pct });
    detail = label;
  } else if (sync.phase === 'outdated') {
    state = 'outdated';
    label = t('shell.sync_outdated');
    detail = label;
  } else if (counts.readOnly) {
    state = 'read-only';
    label = t('shell.sync_read_only');
    detail = t('shell.sync_detail_read_only', { count: counts.pending });
  } else if (!online || sync.phase === 'offline') {
    state = 'offline';
    label = t('shell.sync_offline');
    detail = t('shell.sync_detail_offline', { count: counts.pending });
  } else if (sync.phase === 'suspended') {
    state = 'paused';
    label = t('shell.sync_paused');
    detail = t('shell.sync_detail_paused', { count: counts.pending });
  } else if (sync.phase === 'quota') {
    state = 'quota';
    label = t('shell.sync_quota');
    detail = label;
  } else if (counts.failed > 0 || sync.phase === 'error') {
    state = 'error';
    label = t('shell.sync_problem');
    detail = t('shell.sync_detail_error', {
      message:
        sync.error ?? t('shell.sync_failed_ops', { count: counts.failed }),
    });
  } else if (counts.pending > 0) {
    state = 'pending';
    label = t('shell.sync_waiting', { count: counts.pending });
    detail = t('shell.sync_detail_pending', {
      count: counts.pending,
      ago: ago(counts.lastSync),
    });
  } else if (sync.phase === 'syncing') {
    label = t('shell.sync_syncing');
  }
  return {
    state,
    label,
    detail,
    pending: counts.pending,
    failed: counts.failed,
    lastSync: counts.lastSync,
    online,
  };
}

/** Printer status for the avatar dot and the staff-menu status row (T-020). */
export function usePrinterStatus() {
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
  const state = failed ? 'failed' : printer ? 'ready' : 'none';
  return { loading, printer, failed, detail, visible, state };
}

function syncDotClass(state: string | undefined): string {
  if (state === 'error') return 'bg-danger';
  if (state === 'paused' || state === 'quota' || state === 'pending') {
    return 'bg-warning';
  }
  if (
    state === 'offline' ||
    state === 'read-only' ||
    state === 'outdated' ||
    state === 'downloading'
  ) {
    return 'bg-border-strong';
  }
  return 'bg-success';
}

/** Staff avatar, account menu, status summary and the individual status rows. */
export function StaffMenu({
  shopName,
  variant = 'topbar',
}: {
  shopName: string | null;
  variant?: 'topbar' | 'rail';
}) {
  const { t } = useTranslation();
  const { staff, role, support } = useCurrentStaff();
  const lock = useSession((s) => s.lock);
  const sync = useSyncStatus();
  const printer = usePrinterStatus();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node))
        setOpen(false);
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const inside = ref.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (inside) triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);
  const name = support ? t('lock.support_profile') : String(staff?.name ?? '');
  const initial = name.slice(0, 1).toUpperCase() || '?';
  const dot =
    sync?.state === 'error' || printer.state === 'failed'
      ? 'bg-danger'
      : sync?.state === 'pending' ||
          sync?.state === 'offline' ||
          sync?.state === 'paused' ||
          sync?.state === 'quota'
        ? 'bg-warning'
        : printer.state === 'none'
          ? 'bg-border-strong'
          : 'bg-success';
  const statusLabel = `${name}. ${t('shell.staff_menu')}. ${sync?.label ?? ''}. ${printer.visible}`;
  const menuPosition =
    variant === 'rail'
      ? 'bottom-0 start-full ms-3 w-80 max-h-[calc(100dvh-6rem)]'
      : 'end-0 top-12 w-72 max-h-[calc(100dvh-5rem)]';

  return (
    <div ref={ref} className="relative">
      {variant === 'rail' ? (
        <button
          ref={triggerRef}
          type="button"
          data-testid="staff-menu"
          data-sync-state={sync?.state}
          data-printer-state={printer.state}
          aria-label={statusLabel}
          title={statusLabel}
          aria-expanded={open}
          aria-controls={menuId}
          aria-haspopup="true"
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-14 w-full flex-col items-center justify-center gap-1 px-1 py-1 text-small text-rail-muted transition-colors duration-150 hover:bg-rail-hover hover:text-rail-ink"
        >
          <span
            aria-hidden="true"
            className="relative flex size-8 items-center justify-center rounded-full bg-primary text-primary-ink"
          >
            <UserIcon className="size-4" />
            <span
              className={`absolute -end-0.5 -top-0.5 size-2.5 rounded-full border-2 border-rail ${dot}`}
            />
          </span>
          <span className="rail-label max-w-full truncate leading-tight">
            {name}
          </span>
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          data-testid="staff-menu"
          data-sync-state={sync?.state}
          data-printer-state={printer.state}
          aria-label={statusLabel}
          title={statusLabel}
          aria-expanded={open}
          aria-controls={menuId}
          aria-haspopup="true"
          className="flex size-11 items-center justify-center"
          onClick={() => setOpen((value) => !value)}
        >
          <span
            aria-hidden="true"
            className="relative flex size-9 items-center justify-center rounded-full bg-primary text-small font-semibold text-primary-ink ring-2 ring-primary-subtle"
          >
            {initial}
            <span
              className={`absolute -end-0.5 -top-0.5 size-2.5 rounded-full border-2 border-surface ${dot}`}
            />
          </span>
        </button>
      )}
      {open ? (
        <div
          id={menuId}
          className={`absolute z-50 overflow-y-auto rounded-card border border-border bg-surface p-3 text-text shadow-modal ${menuPosition}`}
        >
          <div className="flex items-center gap-2 border-b border-border pb-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-text-muted">
              <StoreIcon />
            </span>
            <div className="min-w-0">
              <p className="text-micro font-medium uppercase tracking-[0.12em] text-text-muted">
                {t('shell.shop')}
              </p>
              <p
                className="truncate font-medium"
                data-testid="staff-menu-shop"
                title={shopName ?? undefined}
              >
                {shopName ?? t('common.app_name')}
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-primary-subtle-ink"
              data-testid="staff-menu-user"
            >
              <UserIcon />
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{name}</p>
              <p className="text-small text-text-muted">
                {support ? t('lock.support_profile') : t(`shell.role_${role}`)}
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-0.5 rounded-control border border-border p-1">
            <Link
              to="/settings/sync"
              data-testid="sync-status"
              data-state={sync?.state}
              title={sync?.detail}
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center gap-2 rounded-control px-2 text-small hover:bg-surface-2"
            >
              <span
                aria-hidden="true"
                className={`size-2.5 shrink-0 rounded-full ${syncDotClass(sync?.state)}`}
              />
              <span className="font-medium">{t('shell.sync')}</span>
              <span className="ms-auto max-w-36 truncate text-text-muted">
                {sync?.label ?? '—'}
              </span>
            </Link>
            <Link
              to="/settings/printer"
              data-testid="printer-status"
              data-state={printer.state}
              title={printer.detail}
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center gap-2 rounded-control px-2 text-small hover:bg-surface-2"
            >
              <PrinterIcon className="size-4 shrink-0 text-text-muted" />
              <span className="font-medium">{t('shell.printer_label')}</span>
              <span className="ms-auto max-w-36 truncate text-text-muted">
                {printer.visible}
              </span>
            </Link>
          </div>
          <Link
            to="/settings"
            data-testid="staff-menu-settings"
            onClick={() => setOpen(false)}
            className="mt-2 flex min-h-11 items-center gap-2 rounded-control px-2 text-small hover:bg-surface-2"
          >
            <SettingsIcon className="size-4 shrink-0 text-text-muted" />
            <span className="flex-1">{t('nav.settings')}</span>
            <ChevronRightIcon className="size-4 shrink-0 text-text-muted rtl:rotate-180" />
          </Link>
          <div className="mt-2 border-y border-border py-2">
            <LanguageMenu
              onPicked={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            />
          </div>
          <div className="mt-2 flex flex-col">
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-start text-small hover:bg-surface-2"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new Event('bikri:commands'));
              }}
            >
              <SearchIcon className="size-4 shrink-0 text-text-muted" />
              <span className="flex-1">{t('shell.commands')}</span>
              <KeyBadge keys="Ctrl+K" />
            </button>
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-start text-small hover:bg-surface-2"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new Event('bikri:shortcuts'));
              }}
            >
              <InfoIcon className="size-4 shrink-0 text-text-muted" />
              <span className="flex-1">{t('shell.shortcuts')}</span>
              <KeyBadge keys="?" />
            </button>
            <button
              type="button"
              title={`${t('shell.lock')} (Ctrl+L)`}
              className="mt-1 flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-start text-small hover:bg-surface-2"
              onClick={() => {
                setOpen(false);
                lock();
              }}
            >
              <LockIcon className="size-4 shrink-0 text-text-muted" />
              {t('shell.lock')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
