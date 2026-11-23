/** "Confirm it's you" (screens/17, 05 §3.2) and a hook that runs shop-admin calls behind it. */
import type { BikriDb } from '@bikri/db';
import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
import { useSubmitGuard } from '../components/useSubmitGuard.ts';
import { OfflineError, SyncHttpError } from '../sync/client.ts';
import {
  normaliseSigninCode,
  OwnerSigninRequired,
  ownerSessionValid,
  type SigninStart,
  startOwnerSignin,
  verifyOwnerSignin,
} from '../sync/shopApi.ts';

const overlayClass = 'bikri-overlay fixed inset-0 z-40 bg-scrim';
const contentClass =
  'bikri-dialog fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(28rem,calc(100%-2rem))] flex-col gap-4 rounded-modal border border-border bg-surface p-4 text-text shadow-modal';

export function shopErrorMessage(
  t: (k: string, o?: Record<string, unknown>) => string,
  e: unknown,
): string {
  if (e instanceof OfflineError) return t('owner.offline');
  if (e instanceof SyncHttpError) {
    if (e.code === 'EMAIL_UNAVAILABLE') return t('owner.email_unavailable');
    if (e.code === 'OWNER_EMAIL_MISSING') return t('owner.email_missing');
    if (e.code === 'UNAUTHENTICATED') return t('owner.not_enrolled');
    if (e.code === 'RATE_LIMITED')
      return t('owner.rate_limited', {
        minutes: Math.max(1, Math.ceil((e.retryAfter ?? 60) / 60)),
      });
    if (e.code === 'TENANT_READ_ONLY') return t('tenant.readOnly.blocked');
    if (e.code === 'LAST_ADMIN_DEVICE') return t('devices.last_admin');
    return t('errors.generic');
  }
  return t('errors.generic');
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function OwnerSigninDialog({
  db,
  staffId,
  open,
  onDone,
  onCancel,
}: {
  db: BikriDb;
  staffId: string;
  open: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [start, setStart] = useState<
    (SigninStart & { sent_at: number }) | null
  >(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const codeRef = useRef<HTMLInputElement>(null);
  const sendSeq = useRef(0);
  const openRef = useRef(open);
  const confirmGuard = useSubmitGuard();

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  const send = useCallback(async () => {
    sendSeq.current += 1;
    const mine = sendSeq.current;
    setBusy(true);
    setError(null);
    try {
      const res = await startOwnerSignin(db, staffId);
      if (!openRef.current || mine !== sendSeq.current) return;
      setStart({ ...res, sent_at: Date.now() });
      setCode('');
    } catch (e) {
      if (!openRef.current || mine !== sendSeq.current) return;
      setError(shopErrorMessage(t, e));
    } finally {
      setBusy(false);
    }
  }, [db, staffId, t]);

  useEffect(() => {
    if (open && !start && !busy && !error) void send();
  }, [open, start, busy, error, send]);

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      sendSeq.current += 1;
      setStart(null);
      setError(null);
      setCode('');
    }
  }, [open]);

  useEffect(() => {
    if (start) codeRef.current?.focus();
  }, [start]);

  const confirm = async () => {
    if (!start) return;
    if (code.length !== 6) {
      setError(t('owner.code_six'));
      return;
    }
    // Enter plus a click can submit twice in one tick; lock before awaiting.
    if (!confirmGuard.lock()) return;
    setBusy(true);
    setError(null);
    try {
      await verifyOwnerSignin(db, staffId, start.code_id, code);
      onDone();
    } catch (e) {
      if (e instanceof SyncHttpError && e.code === 'BAD_SIGNIN_CODE') {
        const left = Number(e.details.tries_left ?? 0);
        setError(
          left > 0
            ? t('owner.wrong_code', { count: left })
            : t('owner.code_dead'),
        );
      } else setError(shopErrorMessage(t, e));
    } finally {
      confirmGuard.unlock();
      setBusy(false);
    }
  };

  const resendIn = start ? 60_000 - (now - start.sent_at) : 0;
  const left = start ? start.expires_at - now : 0;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? undefined : onCancel())}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content
          aria-modal="true"
          className={contentClass}
          data-testid="owner-signin"
        >
          <Dialog.Title className="text-title font-semibold">
            {t('owner.title')}
          </Dialog.Title>
          <Dialog.Description>
            {start
              ? t('owner.sent', { email: start.email_hint })
              : t('owner.sending')}
          </Dialog.Description>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <label className="flex flex-col gap-1">
              <span>{t('owner.code_label')}</span>
              <input
                ref={codeRef}
                className={`${fieldClass} tracking-widest`}
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                disabled={!start}
                onChange={(e) => setCode(normaliseSigninCode(e.target.value))}
              />
            </label>
            {start ? (
              <p className="text-small text-text-muted">
                {left > 0
                  ? t('owner.expires_in', { time: mmss(left) })
                  : t('owner.code_dead')}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-danger text-small">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={buttonQuiet}
                disabled={busy || resendIn > 0}
                onClick={() => void send()}
              >
                {resendIn > 0
                  ? t('owner.send_again_in', { time: mmss(resendIn) })
                  : t('owner.send_again')}
              </button>
              <button type="button" className={buttonQuiet} onClick={onCancel}>
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className={buttonPrimary}
                disabled={busy || !start}
              >
                {t('common.confirm')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * `run(fn)` performs a shop-admin call; when the owner session is missing it opens
 * "Confirm it's you" first and retries once after sign-in. Rejects with OwnerSigninRequired on cancel.
 */
export function useShopAdmin(db: BikriDb | null, staffId: string | null) {
  const [open, setOpen] = useState(false);
  const waiters = useRef<
    { resolve: () => void; reject: (e: unknown) => void }[]
  >([]);

  const ensure = useCallback(() => {
    // A hook called with no database or staff (a render before enrolment) must fail
    // fast with the typed error instead of opening a dialog that can never resolve.
    if (!db || !staffId) return Promise.reject(new OwnerSigninRequired());
    if (ownerSessionValid(staffId)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      waiters.current.push({ resolve, reject });
      setOpen(true);
    });
  }, [db, staffId]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      await ensure();
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof OwnerSigninRequired)) throw e;
        await ensure();
        return fn();
      }
    },
    [ensure],
  );

  const dialog =
    db && staffId ? (
      <OwnerSigninDialog
        db={db}
        staffId={staffId}
        open={open}
        onDone={() => {
          setOpen(false);
          for (const w of waiters.current.splice(0)) w.resolve();
        }}
        onCancel={() => {
          setOpen(false);
          for (const w of waiters.current.splice(0))
            w.reject(new OwnerSigninRequired());
        }}
      />
    ) : null;
  return { run, dialog };
}
