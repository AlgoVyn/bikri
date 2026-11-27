/** Enrol this device (screens/02, T-034). Rendered by the gate without the app shell. */
import { BASE_PATH } from '@bikri/core';
import type { BikriDb } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BikriMark } from '../components/BikriMark.tsx';
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  fieldClass,
  monoFieldClass,
} from '../components/classes.ts';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { OverrideDialog } from '../components/OverrideDialog.tsx';
import {
  CODE_RE,
  defaultDeviceName,
  enrolDevice,
  finishInitialSync,
  formatCode,
  INITIAL_SYNC_PENDING_KEY,
  leaveShop,
  markUnsyncedExported,
  normaliseCodeInput,
  PendingFilesError,
  pendingFileCount,
  UnsyncedOpsError,
  unexportedOps,
  unsyncedExport,
} from '../data/enrol.ts';
import { verifyPinWithLockout } from '../data/pinLock.ts';
import { OfflineError, SyncHttpError } from '../sync/client.ts';
import { pullAll } from '../sync/pull.ts';

export type EnrolPageProps = {
  /** The database this browser is connected to, if any (already-connected and revoked views). */
  db: BikriDb | null;
  shopName: string | null;
  revoked: boolean;
  /** Go to the app after a finished download (reloads so every module sees the new shop). */
  onDone?: () => void;
};

let urlCode: string | null = null;

/** Reads `?code=` once (StrictMode runs initialisers twice) and removes it from the address bar. */
function codeFromUrl(): string {
  if (urlCode !== null) return urlCode;
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (!code) return '';
  urlCode = normaliseCodeInput(code);
  url.searchParams.delete('code');
  window.history.replaceState(window.history.state, '', url.toString());
  return normaliseCodeInput(code);
}

function useOnline(): boolean {
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function reloadHome(): void {
  window.location.assign(import.meta.env.BASE_URL || '/');
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportUnsynced(db: BikriDb): Promise<void> {
  const file = await unsyncedExport(db);
  downloadJson(file.filename, file.data);
  await markUnsyncedExported(db, file.snapshot);
}

type Stage =
  | { kind: 'form' }
  | {
      kind: 'downloading';
      shop: string;
      db: BikriDb;
      done: number;
      total: number;
    }
  | { kind: 'failed'; shop: string; db: BikriDb; message: string }
  | { kind: 'left'; shop: string };

export function EnrolPage({
  db,
  shopName,
  revoked,
  onDone = reloadHome,
}: EnrolPageProps) {
  const { t } = useTranslation();
  const online = useOnline();
  const [initialCode] = useState(codeFromUrl);
  const [tab, setTab] = useState<'code' | 'new'>('code');
  const [code, setCode] = useState(initialCode);
  // Empty keeps the name the owner put on the code (D-107); the placeholder suggests one.
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [connected, setConnected] = useState<{
    db: BikriDb;
    shop: string;
  } | null>(db && shopName && !revoked ? { db, shop: shopName } : null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leavePinOpen, setLeavePinOpen] = useState(false);
  const ownerProfiles = useLiveQuery(async () => {
    if (!connected) return [];
    return (await connected.db.staff.toArray())
      .filter(
        (row) => row.role === 'owner' && row.active === 1 && !row.deleted_at,
      )
      .map((row) => ({ id: String(row.id), label: String(row.name) }));
  }, [connected?.db.tenantId]);

  // A "Not my shop" click during the download must win over the in-flight pull:
  // bumping the generation makes every later callback (progress, finish, onDone) a no-op.
  const downloadSeq = useRef(0);
  const cancelDownload = () => {
    downloadSeq.current += 1;
  };
  const download = useCallback(
    async (target: BikriDb, shop: string) => {
      const generation = downloadSeq.current + 1;
      downloadSeq.current = generation;
      setStage({ kind: 'downloading', shop, db: target, done: 0, total: 0 });
      try {
        await pullAll(target, (done, total) => {
          if (generation !== downloadSeq.current) return;
          setStage({ kind: 'downloading', shop, db: target, done, total });
        });
        if (generation !== downloadSeq.current) return;
        // The first snapshot is complete: the gate may open the app (SYNC-H4).
        await finishInitialSync(target);
        if (generation !== downloadSeq.current) return;
        onDone();
      } catch (e) {
        if (generation !== downloadSeq.current) return;
        setStage({
          kind: 'failed',
          shop,
          db: target,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [onDone],
  );

  // A reload in the middle of enrolment lands here with the token already stored and
  // `initial_sync_pending` set. Resume the download instead of showing "already
  // connected" over a half-empty database; the sync engine stays off until it finishes.
  const resumePending = useLiveQuery(
    async () =>
      db ? (await db.kv.get(INITIAL_SYNC_PENDING_KEY))?.value === true : false,
    [db?.tenantId],
  );
  const resuming = useRef(false);
  useEffect(() => {
    if (
      resuming.current ||
      resumePending !== true ||
      !db ||
      !shopName ||
      revoked ||
      stage.kind !== 'form'
    )
      return;
    resuming.current = true;
    void download(db, shopName);
  }, [db, shopName, revoked, resumePending, stage.kind, download]);

  const connectGuard = useRef(false);
  const connect = async () => {
    // Lock synchronously: the awaits below let a double click start two enrolments.
    if (connectGuard.current) return;
    connectGuard.current = true;
    try {
      const normalised = normaliseCodeInput(code);
      if (!CODE_RE.test(normalised)) {
        setError(t('enrol.err_code'));
        return;
      }
      if (revoked && db) {
        const count = await unexportedOps(db);
        if (count > 0) {
          setError(t('enrol.leave_blocked', { count }));
          return;
        }
        const files = await pendingFileCount(db);
        if (files > 0) {
          setError(t('enrol.leave_files_blocked', { count: files }));
          return;
        }
      }
      setBusy(true);
      setError(null);
      try {
        const { db: target, res } = await enrolDevice(normalised, name.trim());
        void download(target, res.tenant.display_name);
      } catch (e) {
        if (e instanceof OfflineError) setError(t('enrol.err_offline'));
        else if (e instanceof SyncHttpError) {
          if (e.code === 'BAD_ENROLMENT_CODE') setError(t('enrol.err_bad'));
          else if (e.code === 'TENANT_SUSPENDED')
            setError(t('enrol.err_suspended'));
          else if (e.code === 'RATE_LIMITED') setError(t('enrol.err_rate'));
          else setError(t('enrol.err_other', { message: e.message || e.code }));
        } else setError(t('enrol.err_other', { message: String(e) }));
      } finally {
        setBusy(false);
      }
    } finally {
      connectGuard.current = false;
    }
  };

  const leave = async (target: BikriDb, after: Stage | null) => {
    setLeaveError(null);
    try {
      await leaveShop(target);
      setConnected(null);
      setConfirmLeave(false);
      setLeavePinOpen(false);
      if (after) setStage(after);
      else setStage({ kind: 'form' });
    } catch (e) {
      if (e instanceof UnsyncedOpsError)
        setLeaveError(t('enrol.leave_blocked', { count: e.count }));
      else if (e instanceof PendingFilesError)
        setLeaveError(t('enrol.leave_files_blocked', { count: e.count }));
      else setLeaveError(String(e));
    }
  };

  const verifyLeavePin = async (pin: string, profileId: string) => {
    if (!connected || !profileId) return false;
    const result = await verifyPinWithLockout(connected.db, profileId, pin);
    if (result.kind !== 'ok') return false;
    setTimeout(() => void leave(connected.db, null), 0);
    return true;
  };

  const card = (body: React.ReactNode) => (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-card border border-divider bg-surface p-6 shadow-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BikriMark className="size-8" />
            <p className="text-h2 font-semibold tracking-wordmark">
              {t('common.app_name')}
            </p>
          </div>
          <LanguageSelect />
        </div>
        {body}
      </div>
    </main>
  );

  if (stage.kind === 'downloading' || stage.kind === 'failed') {
    // The snapshot start carries no per-table counts (03 §4.3), so `total` is usually 0
    // and a 0–100 bar would sit at 0% for the whole download. Show the rows that have
    // already landed and an indeterminate bar instead; the count moves every page.
    const knownTotal = stage.kind === 'downloading' ? stage.total : 0;
    const pct =
      knownTotal > 0 && stage.kind === 'downloading'
        ? Math.round((stage.done / knownTotal) * 100)
        : 0;
    return card(
      <>
        <p role="status" className="text-body">
          {t('enrol.connected', { shop: stage.shop })}
        </p>
        {stage.kind === 'downloading' ? (
          <>
            <p className="text-small text-text-muted">
              {knownTotal > 0
                ? t('enrol.downloading_count', {
                    done: stage.done.toLocaleString(),
                    total: knownTotal.toLocaleString(),
                  })
                : stage.done > 0
                  ? t('enrol.downloading_rows', {
                      count: stage.done,
                      rows: stage.done.toLocaleString(),
                    })
                  : t('enrol.downloading')}
            </p>
            <progress
              className="w-full"
              max={knownTotal > 0 ? 100 : undefined}
              value={knownTotal > 0 ? pct : undefined}
              aria-label={t('enrol.downloading')}
            />
          </>
        ) : (
          <>
            <p role="alert" className="text-danger">
              {t('enrol.download_failed', { message: stage.message })}
            </p>
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => void download(stage.db, stage.shop)}
            >
              {t('enrol.retry')}
            </button>
          </>
        )}
        <button
          type="button"
          className="self-start text-primary text-small underline"
          onClick={() => {
            cancelDownload();
            void leave(stage.db, { kind: 'left', shop: stage.shop });
          }}
        >
          {t('enrol.not_mine')}
        </button>
        {leaveError ? (
          <p role="alert" className="text-danger text-small">
            {leaveError}
          </p>
        ) : null}
      </>,
    );
  }

  if (connected) {
    return (
      <>
        {card(
          <>
            <h1 className="font-semibold text-h2">
              {t('enrol.already', { shop: connected.shop })}
            </h1>
            <button type="button" className={buttonPrimary} onClick={onDone}>
              {t('enrol.open', { shop: connected.shop })}
            </button>
            {confirmLeave ? (
              <div className="flex flex-col gap-2 rounded-control border border-divider p-3">
                <p>{t('enrol.leave_confirm', { shop: connected.shop })}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={buttonDanger}
                    disabled={ownerProfiles === undefined}
                    onClick={() => {
                      if ((ownerProfiles?.length ?? 0) > 0)
                        setLeavePinOpen(true);
                      else void leave(connected.db, null);
                    }}
                  >
                    {t('enrol.leave')}
                  </button>
                  <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() => setConfirmLeave(false)}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className={buttonQuiet}
                disabled={ownerProfiles === undefined}
                onClick={() => setConfirmLeave(true)}
              >
                {t('enrol.leave')}
              </button>
            )}
            {leaveError ? (
              <div className="flex flex-col gap-2">
                <p role="alert" className="text-danger text-small">
                  {leaveError}
                </p>
                <button
                  type="button"
                  className={buttonQuiet}
                  onClick={() => void exportUnsynced(connected.db)}
                >
                  {t('enrol.export_unsynced')}
                </button>
              </div>
            ) : null}
          </>,
        )}
        <OverrideDialog
          open={leavePinOpen}
          onOpenChange={setLeavePinOpen}
          title={t('enrol.leave_pin_title')}
          body={t('enrol.leave_pin_body')}
          profiles={ownerProfiles ?? []}
          verify={verifyLeavePin}
        />
      </>
    );
  }

  const codeError = error;
  return card(
    <>
      <h1 className="font-semibold text-h2">{t('enrol.heading')}</h1>
      {stage.kind === 'left' ? (
        <p role="status" className="text-small">
          {t('enrol.not_mine_help', { shop: stage.shop })}
        </p>
      ) : null}
      <div role="tablist" className="flex gap-2">
        {(['code', 'new'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`${buttonQuiet} aria-selected:border-primary aria-selected:bg-primary-subtle aria-selected:text-primary-subtle-ink`}
            onClick={() => setTab(id)}
          >
            {t(id === 'code' ? 'enrol.tab_code' : 'enrol.tab_new')}
          </button>
        ))}
      </div>
      {tab === 'new' ? (
        <p className="text-small">{t('enrol.new_shop_help')}</p>
      ) : null}
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <label className="flex flex-col gap-1">
          <span>{t('enrol.code_label')}</span>
          <input
            className={`${monoFieldClass} uppercase tracking-widest`}
            value={formatCode(code)}
            onChange={(e) => {
              setCode(normaliseCodeInput(e.target.value));
              setError(null);
            }}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            maxLength={9}
            aria-invalid={codeError ? true : undefined}
            aria-describedby={codeError ? 'enrol-error' : undefined}
            placeholder="ABCD-EFGH"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t('enrol.name_label')}</span>
          <input
            className={fieldClass}
            value={name}
            maxLength={60}
            placeholder={defaultDeviceName()}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {codeError ? (
          <p id="enrol-error" role="alert" className="text-danger text-small">
            {codeError}
          </p>
        ) : null}
        {!online ? (
          <p className="text-small text-text-muted">{t('enrol.err_offline')}</p>
        ) : null}
        <button
          type="submit"
          className={buttonPrimary}
          disabled={!online || busy}
        >
          {busy ? t('enrol.connecting') : t('enrol.connect')}
        </button>
      </form>
      <p className="border-t border-divider pt-3 text-center text-small text-text-muted">
        {t('enrol.request_shop_hint')}{' '}
        <a
          className="inline-flex min-h-11 items-center text-primary underline underline-offset-2"
          href={`${BASE_PATH}/request`}
        >
          {t('enrol.request_shop_link')}
        </a>
      </p>
      {tab === 'new' ? (
        <details className="text-small">
          <summary className="cursor-pointer text-primary">
            {t('enrol.privacy_link')}
          </summary>
          <p className="mt-2">{t('enrol.privacy_text')}</p>
        </details>
      ) : null}
      {revoked && db ? (
        <div className="flex flex-col gap-2 rounded-control border border-divider p-3">
          <p>{t('enrol.revoked')}</p>
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => void exportUnsynced(db)}
          >
            {t('enrol.export_unsynced')}
          </button>
        </div>
      ) : null}
    </>,
  );
}
