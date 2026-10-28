/** Settings → Sync (screens/17, T-036): status, failed ops, conflicts, Sync now. */

import { newId } from '@bikri/core';
import type { OutboxEntry, SyncedRow } from '@bikri/db';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
} from '../components/classes.ts';
import { getDb } from '../data/db.ts';
import { getKv } from '../data/kv.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { writeAction } from '../data/write.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { syncNow } from '../sync/engine.ts';
import { discardFailed, retryFailed } from '../sync/push.ts';
import { OwnerSigninRequired, shopRequest } from '../sync/shopApi.ts';
import { useSyncState } from '../sync/state.ts';
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
    const [pending, failed, conflicts, device, lastSync, status, token] =
      await Promise.all([
        db.outbox.where('status').equals('pending').count(),
        db.outbox.where('status').equals('failed').toArray(),
        db.sync_conflicts.toArray(),
        deviceInfo(db),
        getKv<number | null>(db, 'last_sync_at', null),
        getKv<{ status: string } | null>(db, 'tenant_status', null),
        getKv<string | null>(db, 'device_token', null),
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
          entity_id: null,
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
    <div
      className="mx-auto flex max-w-3xl flex-col gap-4 p-4"
      data-testid="sync-page"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/settings" className={buttonQuiet}>
          {t('common.back')}
        </Link>
        <h1 className="text-h1 font-semibold">{t('syncpage.title')}</h1>
      </div>
      {!data.enrolled ? (
        <p className="text-text-muted">{t('syncpage.not_enrolled')}</p>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-card border border-border bg-surface p-4">
        <dt className="text-text-muted">{t('syncpage.last_sync')}</dt>
        <dd>{formatWhen(i18n.language, sync.lastSyncAt ?? data.lastSync)}</dd>
        <dt className="text-text-muted">{t('syncpage.waiting')}</dt>
        <dd data-testid="sync-pending">{data.pending}</dd>
        <dt className="text-text-muted">{t('syncpage.device')}</dt>
        <dd>
          {data.device ? `${data.device.name} · ${data.device.code}` : '—'}
        </dd>
        <dt className="text-text-muted">{t('syncpage.storage')}</dt>
        <dd>
          {storage
            ? t('syncpage.storage_value', {
                mb: (storage.usage / 1_048_576).toFixed(1),
                persisted: storage.persisted
                  ? t('syncpage.persisted_yes')
                  : t('syncpage.persisted_no'),
              })
            : '—'}
        </dd>
      </dl>
      {sync.phase === 'quota' && sync.quotaUntil ? (
        <p
          role="status"
          className="rounded-control bg-warning-subtle p-3 text-warning-subtle-ink"
        >
          {t('syncpage.quota', {
            time: formatWhen(i18n.language, sync.quotaUntil),
          })}
        </p>
      ) : null}
      {data.readOnly && data.pending > 0 ? (
        <p
          role="status"
          className="rounded-control bg-warning-subtle p-3 text-warning-subtle-ink"
        >
          {t('syncpage.read_only_waiting')}
        </p>
      ) : null}
      {sync.phase === 'error' && sync.error ? (
        <p role="alert" className="text-danger">
          {t('syncpage.problem', { message: sync.error })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
      <div>
        <button
          type="button"
          className={buttonPrimary}
          disabled={busy || !data.enrolled}
          onClick={() => {
            setBusy(true);
            void syncNow().finally(() => setBusy(false));
          }}
        >
          {busy ? t('shell.sync_syncing') : t('syncpage.sync_now')}
        </button>
      </div>

      {data.failed.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-h2 font-semibold">
            {t('syncpage.failed_title', { count: data.failed.length })}
          </h2>
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
            {data.failed.map((e) => (
              <li
                key={e.seq}
                className="flex flex-wrap items-center justify-between gap-2 p-3"
                data-testid="failed-op"
              >
                <span>
                  {e.tbl} · {e.kind} ·{' '}
                  <span className="text-danger">{e.last_error ?? '—'}</span>
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() => void retryFailed(db, [e.seq as number])}
                  >
                    {t('syncpage.retry')}
                  </button>
                  {owner ? (
                    <button
                      type="button"
                      className={buttonDanger}
                      onClick={() => void discard([e])}
                    >
                      {t('syncpage.discard')}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-h2 font-semibold">
          {t('syncpage.conflicts_title')}
        </h2>
        {data.conflicts.length === 0 ? (
          <p className="text-text-muted">{t('syncpage.no_conflicts')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
            {data.conflicts.map((c) => (
              <li
                key={String(c.id)}
                className="flex flex-wrap items-center justify-between gap-2 p-3"
                data-testid="conflict"
              >
                <span>
                  {t(`syncpage.conflict_${String(c.kind)}`, {
                    defaultValue: String(c.kind),
                  })}{' '}
                  · {String(c.tbl)} · {formatWhen(i18n.language, Number(c.at))}
                </span>
                {owner && data.device?.is_admin ? (
                  <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() => void acknowledge(String(c.id))}
                  >
                    {t('syncpage.acknowledge')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {dialog}
    </div>
  );
}
