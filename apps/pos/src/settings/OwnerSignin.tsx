/** "Confirm it's you" (screens/17, 05 §3.2) and a hook that runs shop-admin calls behind it. */
import type { BikriDb } from '@bikri/db';
import { Box, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../sell/Modal.tsx';
import { OfflineError, SyncHttpError } from '../sync/client.ts';
import {
  normaliseSigninCode,
  OwnerSigninRequired,
  ownerSessionValid,
  type SigninStart,
  startOwnerSignin,
  verifyOwnerSignin,
} from '../sync/shopApi.ts';

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
    return e.message || e.code;
  }
  return e instanceof Error ? e.message : String(e);
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

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  const send = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await startOwnerSignin(db, staffId);
      setStart({ ...res, sent_at: Date.now() });
      setCode('');
    } catch (e) {
      setError(shopErrorMessage(t, e));
    } finally {
      setBusy(false);
    }
  }, [db, staffId, t]);

  useEffect(() => {
    if (open && !start && !busy && !error) void send();
  }, [open, start, busy, error, send]);

  useEffect(() => {
    if (!open) {
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
      setBusy(false);
    }
  };

  const resendIn = start ? 60_000 - (now - start.sent_at) : 0;
  const left = start ? start.expires_at - now : 0;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={t('owner.title')}
      description={
        start
          ? t('owner.sent', { email: start.email_hint })
          : t('owner.sending')
      }
      testId="owner-signin"
    >
      <Box
        component="form"
        onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <Stack gap="sm">
          <TextInput
            ref={codeRef}
            label={t('owner.code_label')}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            disabled={!start}
            data-autofocus
            onChange={(event) =>
              setCode(normaliseSigninCode(event.currentTarget.value))
            }
            styles={{ input: { letterSpacing: '0.12em' } }}
          />
          {start ? (
            <Text size="sm" c="dimmed">
              {left > 0
                ? t('owner.expires_in', { time: mmss(left) })
                : t('owner.code_dead')}
            </Text>
          ) : null}
          {error ? (
            <Text role="alert" c="danger" size="sm">
              {error}
            </Text>
          ) : null}
          <Group justify="flex-end" gap="sm">
            <Button
              type="button"
              variant="default"
              disabled={busy || resendIn > 0}
              onClick={() => void send()}
            >
              {resendIn > 0
                ? t('owner.send_again_in', { time: mmss(resendIn) })
                : t('owner.send_again')}
            </Button>
            <Button type="button" variant="default" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || !start} loading={busy}>
              {t('common.confirm')}
            </Button>
          </Group>
        </Stack>
      </Box>
    </Modal>
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
    if (staffId && ownerSessionValid(staffId)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      waiters.current.push({ resolve, reject });
      setOpen(true);
    });
  }, [staffId]);

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
