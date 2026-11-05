import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  LockIcon,
  SearchIcon,
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

/** Eye toggle for privacy mode (screens/04). One tap hides every amount on browsing screens. */
export function PrivacyToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = enabled ? t('privacy.show') : t('privacy.hide');
  return (
    <button
      type="button"
      data-testid="privacy-toggle"
      aria-label={t('privacy.hide')}
      aria-pressed={enabled}
      title={`${label} (Ctrl+Shift+H)`}
      onClick={onToggle}
      className="flex size-11 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink"
    >
      {enabled ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}

/** Rail badge (03 §7): one status trigger; printer details live in its popover. */
export function SyncBadge({ compact = false }: { compact?: boolean } = {}) {
  const { t } = useTranslation();
  const online = useOnline();
  const sync = useSyncState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
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

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
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
    tone = 'bg-surface-2 text-text-muted';
    label = t('shell.sync_waiting', { count: counts.pending });
    detail = t('shell.sync_detail_pending', {
      count: counts.pending,
      ago: ago(counts.lastSync),
    });
  } else if (sync.phase === 'syncing') {
    label = t('shell.sync_syncing');
  }

  if (compact) {
    return (
      <Link
        to="/settings/sync"
        data-testid="sync-badge-menu"
        data-state={state}
        aria-label={label}
        title={detail}
        className={`relative inline-flex h-8 items-center gap-1 rounded-full px-2 text-small before:absolute before:-inset-2 before:content-[''] ${tone}`}
      >
        <span aria-hidden="true" className="size-2 rounded-full bg-current" />
        <span>{label}</span>
      </Link>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="sync-badge"
        data-state={state}
        aria-label={label}
        title={detail}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        className="relative hidden h-9 items-center gap-1.5 rounded-full px-2.5 text-small text-text transition-colors duration-150 before:absolute before:-inset-1.5 before:content-[''] hover:bg-surface-2 lg:inline-flex"
      >
        <span
          aria-hidden="true"
          className={`size-2.5 shrink-0 rounded-full ${
            state === 'synced'
              ? 'bg-success'
              : state === 'error'
                ? 'bg-danger'
                : state === 'paused' || state === 'quota'
                  ? 'bg-warning'
                  : state === 'pending' ||
                      state === 'offline' ||
                      state === 'read-only'
                    ? 'bg-border-strong'
                    : 'bg-info'
          }`}
        />
        <span className="hidden max-w-40 truncate xl:inline">{label}</span>
      </button>
      <div
        id={menuId}
        className={`${
          open ? 'flex' : 'hidden'
        } absolute end-0 top-10 z-40 w-64 flex-col gap-2 rounded-card border border-border bg-surface p-3 shadow-modal`}
      >
        <div className="flex flex-col gap-1">
          <Link
            to="/settings/sync"
            data-testid="sync-pill"
            aria-label={label}
            title={detail}
            onClick={() => setOpen(false)}
            className={`inline-flex h-8 w-fit items-center gap-1.5 rounded-full px-2.5 text-small font-medium ${tone}`}
          >
            <span
              aria-hidden="true"
              className="size-2 rounded-full bg-current"
            />
            {label}
          </Link>
          <p className="text-small text-text-muted">{detail}</p>
        </div>
        <div className="border-t border-border pt-2">
          <PrinterDot onClick={() => setOpen(false)} />
        </div>
      </div>
    </div>
  );
}

/** Printer status pill: green when set up, red when this device has no printer (T-020). */
export function PrinterDot({
  compact = false,
  onClick,
}: {
  compact?: boolean;
  onClick?: () => void;
} = {}) {
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
  return (
    <Link
      to="/settings/printer"
      data-testid={compact ? 'printer-dot-menu' : 'printer-dot'}
      aria-label={visible === detail ? detail : `${visible}. ${detail}`}
      title={detail}
      onClick={onClick}
      className={`relative ${compact ? 'inline-flex' : 'hidden lg:inline-flex'} h-8 items-center gap-1 rounded-full px-2 text-small before:absolute before:-inset-2 before:content-[''] ${
        loading
          ? 'bg-surface-2 text-text-muted'
          : failed
            ? 'bg-danger-subtle text-danger-subtle-ink'
            : printer
              ? 'bg-success-subtle text-success-subtle-ink'
              : 'bg-surface-2 text-text-muted'
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${
          loading || (!printer && !failed)
            ? 'bg-border-strong'
            : failed
              ? 'bg-danger'
              : 'bg-success'
        }`}
      />
      <span>{visible}</span>
    </Link>
  );
}

/** Staff avatar with name, role and Lock (T-035; unlocking another profile switches user). */
export function StaffMenu({ shopName }: { shopName: string | null }) {
  const { t } = useTranslation();
  const { staff, role, support } = useCurrentStaff();
  const lock = useSession((s) => s.lock);
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
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const name = support ? t('lock.support_profile') : String(staff?.name ?? '');
  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="staff-menu"
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
          className="absolute end-0 top-12 z-40 max-h-[calc(100dvh-4rem)] w-64 overflow-y-auto rounded-card border border-border bg-surface p-3 shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-border pb-2">
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
          <div className="mt-2 flex items-center gap-2">
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
          <div className="mt-2 border-y border-border py-2">
            <LanguageMenu
              onPicked={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            />
          </div>
          <div className="mt-2 flex flex-col items-start gap-2 border-b border-border pb-2 lg:hidden">
            <SyncBadge compact />
            <PrinterDot compact />
          </div>
          <button
            type="button"
            className="mt-2 flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-start hover:bg-surface-2"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new Event('bikri:commands'));
            }}
          >
            <SearchIcon />
            <span className="flex-1">{t('shell.commands')}</span>
            <KeyBadge keys="Ctrl+K" />
          </button>
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-start hover:bg-surface-2"
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new Event('bikri:shortcuts'));
            }}
          >
            <InfoIcon />
            <span className="flex-1">{t('shell.shortcuts')}</span>
            <KeyBadge keys="?" />
          </button>
          <button
            type="button"
            title={`${t('shell.lock')} (Ctrl+L)`}
            className="mt-2 flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-start hover:bg-surface-2"
            onClick={() => {
              setOpen(false);
              lock();
            }}
          >
            <LockIcon />
            {t('shell.lock')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
