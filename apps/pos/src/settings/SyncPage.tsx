/** Settings → Sync (screens/17, T-036): status, failed ops, conflicts, Sync now. */

import { newId } from '@bikri/core';
import type { OutboxEntry, SyncedRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import {
  buttonDangerQuiet,
  buttonPrimary,
  buttonQuiet,
} from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { CloudIcon } from '../components/icons.tsx';
import { getDb } from '../data/db.ts';
import { getKv } from '../data/kv.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { useShopTimeZone } from '../data/useShopTimeZone.ts';
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
  timeZone = 'Asia/Karachi',
): string {
  if (!at) return '—';
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK' : 'en-PK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(at);
}

export function SyncPage() {
  const { t, i18n } = useTranslation();
  const timeZone = useShopTimeZone();
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
  const [discardTarget, setDiscardTarget] = useState<OutboxEntry[] | null>(
    null,
  );
  const [fileRemoveTarget, setFileRemoveTarget] = useState<number | null>(null);
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
      failedFiles,
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
      db.file_queue.where('status').equals('failed').toArray(),
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
      failedFiles,
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
    try {
      await discardFailed(db, seqs);
    } catch {
      setError(t('errors.generic'));
      return;
    }
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
    ).catch(() => setError(t('errors.generic')));
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
      <div className="flex flex-col gap-4" data-testid="sync-page">
        {!data.enrolled ? (
          <p className="text-text-muted">{t('syncpage.not_enrolled')}</p>
        ) : null}
        {data.pullErrors.length > 0 ? (
          <div
            role="status"
            className="rounded-control bg-warning-subtle p-3 text-small text-warning-subtle-ink"
          >
            <p>
              {t('syncpage.pull_errors', { count: data.pullErrors.length })}
            </p>
            <ul className="mt-1 list-inside list-disc">
              {data.pullErrors.slice(-3).map((row) => (
                <li key={`${row.at}-${row.tbl}-${row.id}`}>
                  {row.tbl} · {row.id} · {row.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-card border border-border bg-surface p-4">
          <dt className="text-text-muted">{t('syncpage.last_sync')}</dt>
          <dd>
            {formatWhen(
              i18n.language,
              sync.lastSyncAt ?? data.lastSync,
              timeZone,
            )}
          </dd>
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
              time: formatWhen(i18n.language, sync.quotaUntil, timeZone),
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
                        className={buttonDangerQuiet}
                        onClick={() => setDiscardTarget([e])}
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

        {data.failedFiles.length > 0 ? (
          <section className="flex flex-col gap-2" data-testid="failed-files">
            <h2 className="text-h2 font-semibold">
              {t('syncpage.files_title', {
                count: data.failedFiles.length,
              })}
            </h2>
            <p className="text-small text-text-muted">
              {t('syncpage.files_hint')}
            </p>
            <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
              {data.failedFiles.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center justify-between gap-2 p-3"
                >
                  <span>
                    {t(`syncpage.file_kind_${e.kind}`)} · {e.target_id}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => {
                        if (e.id === undefined) return;
                        void db.file_queue
                          .update(e.id, {
                            status: 'pending',
                            // Legacy entries queued before the permission check did
                            // not carry a staff id; retry as the unlocked profile.
                            staff_id: staffId ?? e.staff_id ?? null,
                          })
                          .then(() => syncNow());
                      }}
                    >
                      {t('syncpage.file_retry')}
                    </button>
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() =>
                        e.id === undefined
                          ? undefined
                          : setFileRemoveTarget(e.id)
                      }
                    >
                      {t('syncpage.file_remove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="overflow-hidden rounded-card border border-border bg-surface">
          <h2 className="border-b border-border px-4 py-3 text-h2 font-semibold">
            {t('syncpage.conflicts_title')}
          </h2>
          {data.conflicts.length === 0 ? (
            <EmptyState
              variant="plain"
              icon={<CloudIcon />}
              message={t('syncpage.no_conflicts')}
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
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
                    · {String(c.tbl)} ·{' '}
                    {formatWhen(i18n.language, Number(c.at), timeZone)}
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
      <ConfirmDialog
        open={fileRemoveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFileRemoveTarget(null);
        }}
        title={t('syncpage.file_remove_title')}
        body={t('syncpage.file_remove_body')}
        confirmLabel={t('syncpage.file_remove')}
        onConfirm={() => {
          if (fileRemoveTarget !== null)
            void db.file_queue.delete(fileRemoveTarget);
          setFileRemoveTarget(null);
        }}
      />
      <ConfirmDialog
        open={discardTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDiscardTarget(null);
        }}
        title={t('syncpage.discard_title')}
        body={t('syncpage.discard_body', {
          what: discardLabel(discardTarget?.[0]),
        })}
        confirmLabel={t('syncpage.discard_confirm')}
        onConfirm={() => {
          if (discardTarget !== null) void discard(discardTarget);
          setDiscardTarget(null);
        }}
      />
    </SettingsPageLayout>
  );
}

/** The invoice (for ledger rows) or the table/kind for a failed outbox row. */
function discardLabel(entry: OutboxEntry | undefined): string {
  if (!entry) return '';
  const invoice = entry.row?.invoice_no;
  if (typeof invoice === 'string' && invoice !== '') return invoice;
  return `${entry.tbl} · ${entry.kind}`;
}
