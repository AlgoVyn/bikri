import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDb } from '../data/db.ts';
import { tenantInfo } from '../data/localTenant.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

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

/** Outbox state (screens/04): Synced, n waiting, or Sync problem. Push itself is T-030. */
export function SyncBadge() {
  const { t } = useTranslation();
  const counts = useLiveQuery(async () => {
    const db = getDb();
    return {
      pending: await db.outbox.where('status').equals('pending').count(),
      failed: await db.outbox.where('status').equals('failed').count(),
    };
  }, []);
  if (!counts) return null;
  const tone =
    counts.failed > 0
      ? 'bg-danger-subtle text-danger-subtle-ink'
      : counts.pending > 0
        ? 'bg-warning-subtle text-warning-subtle-ink'
        : 'bg-success-subtle text-success-subtle-ink';
  const label =
    counts.failed > 0
      ? t('shell.sync_problem')
      : counts.pending > 0
        ? t('shell.sync_waiting', { count: counts.pending })
        : t('shell.sync_synced');
  return (
    <Link
      to="/settings"
      data-testid="sync-badge"
      aria-label={label}
      title={label}
      className={`inline-flex h-8 items-center gap-1 rounded-full px-2 text-small ${tone}`}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      <span className="max-lg:hidden">{label}</span>
      {counts.failed === 0 && counts.pending > 0 ? (
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

/** Staff avatar with name and role. Switch staff and Lock arrive with the PIN lock (T-035). */
export function StaffMenu() {
  const { t } = useTranslation();
  const { staff, role } = useCurrentStaff();
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
  const name = String(staff?.name ?? '');
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
        <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-ink font-semibold">
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
            {t(`shell.role_${role}`)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
