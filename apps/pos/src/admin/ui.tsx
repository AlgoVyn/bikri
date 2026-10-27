import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
} from '../components/classes.ts';
import { useToast } from '../components/Toast.tsx';
import { countdownParts, formatWhen } from './format.ts';

const dialogClass =
  'fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(28rem,calc(100%-2rem))] flex-col gap-4 overflow-y-auto rounded-modal border-0 bg-surface p-4 text-text shadow-modal backdrop:bg-text/40';

/** Native dialog so the operator pages do not pull Radix into the till bundle. */
export function Modal({
  open,
  title,
  description,
  onClose,
  initialFocus,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!open || el === null) return;
    if (!el.open) el.showModal();
    initialFocus?.current?.focus();
    return () => {
      if (el.open) el.close();
    };
  }, [open, initialFocus]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={dialogClass}
      aria-labelledby={titleId}
      aria-describedby={description !== undefined ? bodyId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        const target = event.target;
        if (target instanceof HTMLTextAreaElement) return;
        if (
          target instanceof HTMLButtonElement &&
          target.dataset.confirm === 'true'
        ) {
          return;
        }
        event.preventDefault();
      }}
    >
      <h2 id={titleId} className="text-title">
        {title}
      </h2>
      {description !== undefined ? <p id={bodyId}>{description}</p> : null}
      {children}
    </dialog>
  );
}

export const primaryBtn = `${buttonPrimary} disabled:opacity-50`;
export const quietBtn = `${buttonQuiet} disabled:opacity-50`;
export const dangerBtn = `${buttonDanger} disabled:opacity-50`;

export function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint !== undefined ? (
        <p id={`${id}-hint`} className="text-small text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Meter({
  label,
  valueText,
  value,
  max,
  warnAt,
}: {
  label: string;
  valueText: string;
  value: number;
  max: number;
  warnAt?: number;
}) {
  const over = max > 0 && value >= max;
  const warn = !over && warnAt !== undefined && value >= warnAt;
  let tone = 'var(--color-primary)';
  if (warn) tone = 'var(--color-warning)';
  if (over) tone = 'var(--color-danger)';
  const limit = max > 0 ? max : Math.max(value, 1);
  return (
    <div>
      <div className="flex justify-between gap-3 text-small">
        <span>{label}</span>
        <span className="tabular-nums">{valueText}</span>
      </div>
      <meter
        className="mt-1 h-2 w-full"
        min={0}
        max={limit}
        value={value}
        aria-label={label}
        style={{ accentColor: tone }}
      />
    </div>
  );
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

export function PairingPanel({
  code,
  link,
  expiresAt,
  shopName,
  heading,
}: {
  code: string;
  link: string;
  expiresAt: number;
  shopName: string;
  heading?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const now = useNow();
  const left = countdownParts(expiresAt, now);
  const when = formatWhen(expiresAt, i18n.language);
  const waText = t('admin.wa_text', { name: shopName, link, code, when });
  const waHref = `https://wa.me/?text=${encodeURIComponent(waText)}`;
  // TODO: draw a QR of `link` if a QR generator is added. None is in the repo;
  // do not pull in a QR dependency for the operator console.
  return (
    <section
      className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4"
      aria-labelledby="pairing-title"
    >
      <h2 id="pairing-title" className="font-semibold">
        {heading ?? t('admin.pairing_once')}
      </h2>
      <p
        className="font-mono text-title tracking-widest"
        data-testid="pairing-code"
      >
        <span className="sr-only">{t('admin.pairing_code')} </span>
        {code}
      </p>
      <p>
        <span className="text-text-muted">{t('admin.pairing_link')} </span>
        <a className="break-all text-primary underline" href={link}>
          {link}
        </a>
      </p>
      <p aria-live="polite">
        {left.done
          ? t('admin.countdown_done')
          : t('admin.countdown', { hours: left.hours, minutes: left.minutes })}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={quietBtn}
          onClick={() => {
            void navigator.clipboard.writeText(link).then(
              () => {
                toast.push(t('admin.copied'), 'info');
              },
              () => {
                toast.push(t('admin.copy_failed'), 'error');
              },
            );
          }}
        >
          {t('admin.copy_link')}
        </button>
        <a className={quietBtn} href={waHref} target="_blank" rel="noreferrer">
          {t('admin.wa')}
        </a>
      </div>
    </section>
  );
}

const SUPPORT_HOURS = [1, 2, 4, 8, 24] as const;

export function HoursDialog({
  open,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string, hours: 1 | 2 | 4 | 8 | 24) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState<(typeof SUPPORT_HOURS)[number]>(2);
  const trimmed = reason.trim();
  const canConfirm =
    trimmed.length >= 1 && trimmed.length <= 200 && pending !== true;
  return (
    <Modal
      open={open}
      title={t('admin.support_start')}
      description={t('admin.support_body')}
      onClose={() => {
        onOpenChange(false);
      }}
      initialFocus={reasonRef}
    >
      <Field
        id="support-reason"
        label={t('admin.reason')}
        hint={t('admin.reason_hint')}
      >
        <textarea
          ref={reasonRef}
          id="support-reason"
          className="min-h-24 w-full rounded-control border border-border-strong bg-surface px-3 py-2"
          maxLength={200}
          value={reason}
          aria-describedby="support-reason-hint"
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      <Field id="support-hours" label={t('admin.hours')}>
        <select
          id="support-hours"
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-2"
          value={hours}
          onChange={(event) => {
            const n = Number(event.target.value);
            if (n === 1 || n === 2 || n === 4 || n === 8 || n === 24)
              setHours(n);
          }}
        >
          {SUPPORT_HOURS.map((n) => (
            <option key={n} value={n}>
              {t('admin.hours_option', { count: n })}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className={quietBtn}
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('common.cancel')}
        </button>
        <button
          ref={confirmRef}
          type="button"
          className={primaryBtn}
          data-confirm="true"
          disabled={!canConfirm}
          onClick={() => {
            if (!canConfirm) return;
            void onConfirm(trimmed, hours).then((ok) => {
              if (ok) onOpenChange(false);
            });
          }}
        >
          {t('admin.support_start')}
        </button>
      </div>
    </Modal>
  );
}

export function ReasonDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  slug,
  targets,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  slug?: string;
  targets?: readonly ('active' | 'read_only')[];
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: {
    reason: string;
    slug: string;
    to: 'active' | 'read_only';
  }) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [to, setTo] = useState<'active' | 'read_only'>('active');
  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= 1 && trimmed.length <= 200;
  const slugOk = slug === undefined || typed === slug;
  const canConfirm = reasonOk && slugOk && pending !== true;

  const close = () => {
    setReason('');
    setTyped('');
    setTo('active');
    onOpenChange(false);
  };
  return (
    <Modal
      open={open}
      title={title}
      description={body}
      onClose={close}
      initialFocus={reasonRef}
    >
      <Field
        id="admin-reason"
        label={t('admin.reason')}
        hint={t('admin.reason_hint')}
      >
        <textarea
          ref={reasonRef}
          id="admin-reason"
          className="min-h-24 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-text"
          maxLength={200}
          value={reason}
          aria-describedby="admin-reason-hint"
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      {slug !== undefined ? (
        <Field id="admin-slug-confirm" label={t('admin.delete_type', { slug })}>
          <input
            id="admin-slug-confirm"
            className="h-11 w-full rounded-control border border-border-strong bg-surface px-3 font-mono text-text"
            value={typed}
            autoComplete="off"
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </Field>
      ) : null}
      {slug !== undefined && typed.length > 0 && typed !== slug ? (
        <p className="text-small text-danger" role="alert">
          {t('admin.delete_slug_mismatch')}
        </p>
      ) : null}
      {targets !== undefined && targets.length > 1 ? (
        <Field id="admin-reactivate-to" label={t('admin.reactivate_to')}>
          <select
            id="admin-reactivate-to"
            className="h-11 w-full rounded-control border border-border-strong bg-surface px-2"
            value={to}
            onChange={(event) => {
              setTo(
                event.target.value === 'read_only' ? 'read_only' : 'active',
              );
            }}
          >
            {targets.map((target) => (
              <option key={target} value={target}>
                {t(
                  target === 'active'
                    ? 'admin.status_active'
                    : 'admin.status_read_only',
                )}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          className={quietBtn}
          onClick={close}
        >
          {t('common.cancel')}
        </button>
        <button
          ref={confirmRef}
          type="button"
          className={danger ? dangerBtn : primaryBtn}
          data-confirm="true"
          disabled={!canConfirm}
          onClick={() => {
            if (!canConfirm) return;
            void onConfirm({
              reason: trimmed,
              slug: typed,
              to: targets?.length === 1 ? (targets[0] ?? 'active') : to,
            }).then((ok) => {
              if (ok) close();
            });
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function AdminConfirm({
  open,
  title,
  body,
  confirmLabel,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      title={title}
      description={body}
      onClose={() => {
        onOpenChange(false);
      }}
      initialFocus={cancelRef}
    >
      <div className="flex flex-wrap justify-end gap-2">
        <button
          ref={cancelRef}
          type="button"
          className={quietBtn}
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={dangerBtn}
          data-confirm="true"
          onClick={() => {
            onConfirm();
            onOpenChange(false);
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
