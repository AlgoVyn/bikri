/** Enrol this device (screens/02, T-034). Rendered by the gate without the app shell. */
import type { BikriDb } from '@bikri/db';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
import { SalesIcon } from '../components/icons.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import {
  CODE_RE,
  defaultDeviceName,
  enrolDevice,
  formatCode,
  leaveShop,
  markUnsyncedExported,
  normaliseCodeInput,
  UnsyncedOpsError,
  unexportedOps,
  unsyncedExport,
} from '../data/enrol.ts';
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
  await markUnsyncedExported(db);
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

  const download = async (target: BikriDb, shop: string) => {
    setStage({ kind: 'downloading', shop, db: target, done: 0, total: 0 });
    try {
      await pullAll(target, (done, total) =>
        setStage({ kind: 'downloading', shop, db: target, done, total }),
      );
      onDone();
    } catch (e) {
      setStage({
        kind: 'failed',
        shop,
        db: target,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const connect = async () => {
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
  };

  const leave = async (target: BikriDb, after: Stage | null) => {
    setLeaveError(null);
    try {
      await leaveShop(target);
      setConnected(null);
      setConfirmLeave(false);
      if (after) setStage(after);
      else setStage({ kind: 'form' });
    } catch (e) {
      if (e instanceof UnsyncedOpsError)
        setLeaveError(t('enrol.leave_blocked', { count: e.count }));
      else setLeaveError(String(e));
    }
  };

  const card = (body: React.ReactNode) => (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-card border border-border bg-surface p-6 shadow-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-[10px] bg-accent text-accent-ink"
            >
              <SalesIcon />
            </span>
            <p className="font-semibold text-h2">{t('common.app_name')}</p>
          </div>
          <LanguageSelect />
        </div>
        {body}
      </div>
    </main>
  );

  if (stage.kind === 'downloading' || stage.kind === 'failed') {
    const pct =
      stage.kind === 'downloading' && stage.total > 0
        ? Math.round((stage.done / stage.total) * 100)
        : 0;
    return card(
      <>
        <p role="status" className="text-body">
          {t('enrol.connected', { shop: stage.shop })}
        </p>
        {stage.kind === 'downloading' ? (
          <>
            <p className="text-small text-text-muted">
              {stage.total > 0
                ? t('enrol.downloading_count', {
                    done: stage.done.toLocaleString(),
                    total: stage.total.toLocaleString(),
                  })
                : t('enrol.downloading')}
            </p>
            <progress
              className="w-full"
              max={100}
              value={pct}
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
          onClick={() =>
            void leave(stage.db, { kind: 'left', shop: stage.shop })
          }
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
    return card(
      <>
        <h1 className="font-semibold text-h2">
          {t('enrol.already', { shop: connected.shop })}
        </h1>
        <button type="button" className={buttonPrimary} onClick={onDone}>
          {t('enrol.open', { shop: connected.shop })}
        </button>
        {confirmLeave ? (
          <div className="flex flex-col gap-2 rounded-control border border-border p-3">
            <p>{t('enrol.leave_confirm', { shop: connected.shop })}</p>
            <div className="flex gap-2">
              <button
                type="button"
                className={buttonDanger}
                onClick={() => void leave(connected.db, null)}
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
            className={tab === id ? buttonPrimary : buttonQuiet}
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
            className={`${fieldClass} uppercase tracking-widest`}
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
      {tab === 'new' ? (
        <details className="text-small">
          <summary className="cursor-pointer text-primary">
            {t('enrol.privacy_link')}
          </summary>
          <p className="mt-2">{t('enrol.privacy_text')}</p>
        </details>
      ) : null}
      {revoked && db ? (
        <div className="flex flex-col gap-2 rounded-control border border-border p-3">
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
