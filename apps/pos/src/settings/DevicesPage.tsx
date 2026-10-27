/** Settings → Devices on an admin device (screens/17, T-038): codes, devices, import unsynced ops. */
import { formatMoney } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
import { QrCode } from '../components/QrCode.tsx';
import { getDb } from '../data/db.ts';
import { formatCode } from '../data/enrol.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { useOnline } from '../shell/TopBarParts.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { OwnerSigninRequired, shopRequest } from '../sync/shopApi.ts';
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
  const { staff, role } = useCurrentStaff();
  const staffId = staff ? String(staff.id) : null;
  const { run, dialog } = useShopAdmin(db, staffId);
  const me = useLiveQuery(() => deviceInfo(db), [db]);
  const branches =
    useLiveQuery(
      async () => (await db.branches.toArray()).filter((b) => !b.deleted_at),
      [db],
    ) ?? [];
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
    if (online && staffId && me?.is_admin && role === 'owner') void guard(load);
  }, [online, staffId, me?.is_admin, role, guard, load]);

  if (!me?.is_admin || role !== 'owner')
    return <p className="p-4 text-text-muted">{t('devices.admin_only')}</p>;
  if (!online)
    return <p className="p-4 text-text-muted">{t('devices.online_only')}</p>;

  const branchName = (id: string) =>
    branches.find((b) => b.id === id)?.name ?? '—';
  const branchId = form.branch || String(me.branch_id);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4">
      <h1 className="text-h1 font-semibold">{t('devices.title')}</h1>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <h2 className="text-h2 font-semibold">{t('devices.add_title')}</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
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
          <label className="flex min-w-48 flex-1 flex-col gap-1">
            <span>{t('devices.name')}</span>
            <input
              className={fieldClass}
              maxLength={40}
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('devices.branch')}</span>
            <select
              className={fieldClass}
              value={branchId}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
            >
              {branches.map((b) => (
                <option key={String(b.id)} value={String(b.id)}>
                  {String(b.name)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={form.admin}
              onChange={(e) => setForm({ ...form, admin: e.target.checked })}
            />
            <span>{t('devices.can_manage')}</span>
          </label>
          <button type="submit" className={buttonPrimary}>
            {t('devices.make_code')}
          </button>
        </form>
        {fresh && fresh.expires_at > now ? (
          <div
            className="flex flex-wrap items-center gap-4"
            data-testid="new-code"
          >
            <QrCode value={fresh.link} label={t('devices.qr_label')} />
            <div className="flex flex-col gap-1">
              <p className="font-mono text-h1 tracking-widest">
                {formatCode(fresh.code)}
              </p>
              <p className="text-small text-text-muted">
                {t('devices.code_expires', {
                  time: `${Math.floor((fresh.expires_at - now) / 60000)}:${String(Math.floor(((fresh.expires_at - now) % 60000) / 1000)).padStart(2, '0')}`,
                })}
              </p>
            </div>
          </div>
        ) : null}
        {codes.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="font-medium">{t('devices.unused_codes')}</h3>
            <ul className="flex flex-col divide-y divide-border">
              {codes.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-2 py-2"
                >
                  <span>
                    {c.device_name}
                    {c.is_admin ? ` · ${t('devices.admin')}` : ''} ·{' '}
                    {timeText(i18n.language, c.expires_at)}
                  </span>
                  <button
                    type="button"
                    className={buttonQuiet}
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
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-h2 font-semibold">{t('devices.list_title')}</h2>
        {devices === null ? (
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => void guard(load)}
          >
            {t('devices.load')}
          </button>
        ) : (
          <ul
            className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface"
            data-testid="device-list"
          >
            {devices.map((d) => (
              <li key={d.id} className="flex flex-col gap-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {renaming?.id === d.id ? (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void guard(async () => {
                          if (!staffId) return;
                          await shopRequest(db, staffId, `/devices/${d.id}`, {
                            method: 'PATCH',
                            json: { name: renaming.name.trim() },
                          });
                          setRenaming(null);
                          await load();
                        });
                      }}
                    >
                      <input
                        className={fieldClass}
                        maxLength={40}
                        value={renaming.name}
                        onChange={(e) =>
                          setRenaming({ id: d.id, name: e.target.value })
                        }
                        aria-label={t('devices.name')}
                      />
                      <button type="submit" className={buttonPrimary}>
                        {t('devices.save')}
                      </button>
                    </form>
                  ) : (
                    <span className="font-medium">{d.name}</span>
                  )}
                  <span className="rounded-full bg-surface-2 px-2 text-small">
                    {d.device_code}
                  </span>
                  {d.is_admin ? (
                    <span className="rounded-full bg-info-subtle px-2 text-small text-info-subtle-ink">
                      {t('devices.admin')}
                    </span>
                  ) : null}
                  {d.kind === 'support' ? (
                    <span className="rounded-full bg-warning-subtle px-2 text-small text-warning-subtle-ink">
                      {t('devices.support', {
                        time: timeText(i18n.language, d.expires_at),
                      })}
                    </span>
                  ) : null}
                  {d.id === me.id ? (
                    <span className="text-small text-text-muted">
                      {t('devices.this_device')}
                    </span>
                  ) : null}
                  {d.revoked_at ? (
                    <span className="text-small text-danger">
                      {t('devices.revoked')}
                    </span>
                  ) : null}
                </div>
                <p className="text-small text-text-muted">
                  {t('devices.meta', {
                    branch: branchName(d.branch_id),
                    seen: timeText(i18n.language, d.last_seen_at),
                    version: d.app_version ?? '—',
                    pending: d.pending_ops,
                  })}
                </p>
                {d.revoked_at ? null : (
                  <div className="flex flex-wrap gap-2">
                    {d.kind === 'till' ? (
                      <>
                        <button
                          type="button"
                          className={buttonQuiet}
                          onClick={() =>
                            setRenaming({ id: d.id, name: d.name })
                          }
                        >
                          {t('devices.rename')}
                        </button>
                        {branches.length > 1 ? (
                          <select
                            className={fieldClass}
                            aria-label={t('devices.move')}
                            value={d.branch_id}
                            onChange={(e) =>
                              void guard(async () => {
                                if (!staffId) return;
                                await shopRequest(
                                  db,
                                  staffId,
                                  `/devices/${d.id}`,
                                  {
                                    method: 'PATCH',
                                    json: { branch_id: e.target.value },
                                  },
                                );
                                await load();
                              })
                            }
                          >
                            {branches.map((b) => (
                              <option key={String(b.id)} value={String(b.id)}>
                                {String(b.name)}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        <button
                          type="button"
                          className={buttonQuiet}
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
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className={buttonDanger}
                      onClick={() => setConfirmRevoke(d)}
                    >
                      {t('devices.revoke')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <h2 className="text-h2 font-semibold">{t('devices.import_title')}</h2>
        <p className="text-small text-text-muted">{t('devices.import_help')}</p>
        <input
          type="file"
          accept="application/json,.json"
          aria-label={t('devices.import_choose')}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
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
        {importState?.kind === 'preview' ? (
          <div className="flex flex-col gap-2" data-testid="import-preview">
            <p>
              {t('devices.import_preview', {
                count: importState.p.count,
                from: timeText(i18n.language, importState.p.from),
                to: timeText(i18n.language, importState.p.to),
                sales: formatMoney(importState.p.sales),
                payments: formatMoney(importState.p.payments),
              })}
            </p>
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => {
                const file = importState.p.file;
                void guard(async () => {
                  if (!staffId) return;
                  setImportState({
                    kind: 'running',
                    done: 0,
                    total: file.ops.length,
                  });
                  const out = await importUnsynced(db, staffId, file, (done) =>
                    setImportState({
                      kind: 'running',
                      done,
                      total: file.ops.length,
                    }),
                  );
                  setImportState({ kind: 'done', ...out });
                });
              }}
            >
              {t('devices.import_go')}
            </button>
          </div>
        ) : null}
        {importState?.kind === 'running' ? (
          <p role="status">
            {t('devices.import_running', {
              done: importState.done,
              total: importState.total,
            })}
          </p>
        ) : null}
        {importState?.kind === 'done' ? (
          <p role="status">
            {t('devices.import_done', {
              applied: importState.applied,
              rejected: importState.rejected,
            })}
          </p>
        ) : null}
      </section>

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
    </div>
  );
}
