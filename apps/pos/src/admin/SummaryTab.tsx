import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import {
  adminErrorMessage,
  endSupport,
  issueCode,
  patchTenant,
  postReason,
  reactivateTenant,
  startSupport,
} from './api.ts';
import {
  barPercent,
  EMAIL_RE,
  formatCount,
  formatWhen,
  statusLabelKey,
} from './format.ts';
import type { IssuedCode, TenantDetail } from './types.ts';
import {
  AdminConfirm,
  dangerBtn,
  Field,
  HoursDialog,
  Modal,
  PairingPanel,
  primaryBtn,
  quietBtn,
  ReasonDialog,
} from './ui.tsx';

type Action =
  | { kind: 'read-only' }
  | { kind: 'suspend' }
  | { kind: 'reactivate' }
  | null;

function targetsFor(
  kind: NonNullable<Action>['kind'] | undefined,
  status: string,
): readonly ('active' | 'read_only')[] | undefined {
  if (kind !== 'reactivate') return undefined;
  if (status === 'suspended') return ['active', 'read_only'];
  return ['active'];
}

export function SummaryTab({
  detail,
  onChanged,
}: {
  detail: TenantDetail;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const tenant = detail.tenant;
  const lang = i18n.language;
  const [action, setAction] = useState<Action>(null);
  const [edit, setEdit] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [issuedHeading, setIssuedHeading] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const status = tenant.status;
  const maxWrite = Math.max(1, ...detail.usage.map((day) => day.rows_written));
  const supportable = status === 'active' || status === 'read_only';
  let actionTitle = t('admin.make_readonly');
  if (action?.kind === 'suspend') actionTitle = t('admin.suspend');
  if (action?.kind === 'reactivate') actionTitle = t('admin.reactivate');
  const reactivateTargets = targetsFor(action?.kind, status);

  const run = async (work: () => Promise<void>, ok: string) => {
    setPending(true);
    try {
      await work();
      toast.push(ok, 'info');
      onChanged();
      return true;
    } catch (err: unknown) {
      toast.push(adminErrorMessage(err, t('admin.err_generic')), 'error');
      return false;
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="grid gap-2 rounded-card border border-border bg-surface p-4 sm:grid-cols-2">
        <p>
          {t('admin.status_since', {
            status: t(statusLabelKey(status)),
            when:
              tenant.status_changed_at === null
                ? t('admin.never')
                : formatWhen(tenant.status_changed_at, lang),
          })}
        </p>
        <p>
          {t('admin.status_reason', {
            reason: tenant.status_reason || t('admin.never'),
          })}
        </p>
        <p>
          {t('admin.status_by', {
            by: tenant.status_changed_by ?? t('admin.never'),
          })}
        </p>
        <p>
          {t('admin.shop_name')}: {detail.shop_name ?? t('admin.never')}
        </p>
        <p>
          {t('admin.created')}: {formatWhen(tenant.created_at, lang)}
        </p>
        <p>
          {t('admin.setup_at')}:{' '}
          {detail.setup_completed_at === null
            ? t('admin.setup_pending')
            : formatWhen(detail.setup_completed_at, lang)}
        </p>
        <p>
          {t('admin.owner_email')}: {tenant.owner_email ?? t('admin.never')}
        </p>
        <p className="tabular-nums">
          {t('admin.budget')}: {formatCount(tenant.daily_write_budget, lang)}
        </p>
        <p className="tabular-nums">
          {t('admin.poll_ms', {
            seconds: Math.round(tenant.poll_after_ms / 1000),
          })}
        </p>
        <p className="font-mono">
          {t('admin.restore_epoch')}: {tenant.restore_epoch}
        </p>
        <p>
          {t('admin.last_restore')}:{' '}
          {tenant.restore_point_at > 0
            ? formatWhen(tenant.restore_point_at, lang)
            : t('admin.never')}
        </p>
        <p>
          {t('admin.last_export')}:{' '}
          {tenant.last_owner_export_at === null
            ? t('admin.never')
            : formatWhen(tenant.last_owner_export_at, lang)}
        </p>
        <p>
          {detail.support
            ? t('admin.support_active', {
                when: formatWhen(detail.support.until, lang),
              })
            : t('admin.support_none')}
        </p>
        {detail.support ? (
          <p>{t('admin.support_reason', { reason: detail.support.reason })}</p>
        ) : null}
      </section>
      <section className="rounded-card border border-border bg-surface p-4">
        <h2 className="font-semibold">{t('admin.usage_7d')}</h2>
        {detail.usage.length === 0 ? (
          <p className="text-text-muted">{t('admin.usage_empty')}</p>
        ) : (
          <ul className="mt-3 flex h-28 items-end gap-2">
            {detail.usage.map((day) => (
              <li
                key={day.day}
                className="flex h-full flex-1 flex-col justify-end"
              >
                <div
                  className="w-full rounded-control bg-primary"
                  style={{
                    height: `${barPercent(day.rows_written, maxWrite)}%`,
                    minHeight: day.rows_written > 0 ? '4px' : '0',
                  }}
                  title={t('admin.writes_bar', {
                    written: formatCount(day.rows_written, lang),
                    budget: day.day,
                  })}
                />
                <span className="mt-1 text-center text-small text-text-muted">
                  {day.day.slice(5)}
                </span>
                <span className="sr-only">
                  {day.day} {formatCount(day.rows_written, lang)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-card border border-border bg-surface p-4">
        <h2 className="font-semibold">{t('admin.history')}</h2>
        {detail.status_history.length === 0 ? (
          <p className="text-text-muted">{t('admin.history_empty')}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {detail.status_history.map((item) => (
              <li key={`${item.at}-${item.to ?? ''}`}>
                {t('admin.history_row', {
                  when: formatWhen(item.at, lang),
                  from: t(statusLabelKey(item.from ?? '')),
                  to: t(statusLabelKey(item.to ?? '')),
                  reason: item.reason ?? t('admin.never'),
                  by: item.by ?? t('admin.never'),
                })}
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={quietBtn}
          onClick={() => setEdit(true)}
        >
          {t('admin.edit')}
        </button>
        {status === 'active' ? (
          <button
            type="button"
            className={quietBtn}
            onClick={() => setAction({ kind: 'read-only' })}
          >
            {t('admin.make_readonly')}
          </button>
        ) : null}
        {status === 'active' || status === 'read_only' ? (
          <button
            type="button"
            className={quietBtn}
            onClick={() => setAction({ kind: 'suspend' })}
          >
            {t('admin.suspend')}
          </button>
        ) : null}
        {status === 'suspended' || status === 'read_only' ? (
          <button
            type="button"
            className={quietBtn}
            onClick={() => setAction({ kind: 'reactivate' })}
          >
            {t('admin.reactivate')}
          </button>
        ) : null}
        {supportable && detail.support ? (
          <button
            type="button"
            className={dangerBtn}
            onClick={() => setEndOpen(true)}
          >
            {t('admin.support_end')}
          </button>
        ) : null}
        {supportable && detail.support === null ? (
          <button
            type="button"
            className={quietBtn}
            onClick={() => setSupportOpen(true)}
          >
            {t('admin.support_start')}
          </button>
        ) : null}
        {status !== 'deleting' ? (
          <button
            type="button"
            className={quietBtn}
            disabled={pending}
            onClick={() => {
              void run(async () => {
                const code = await issueCode(tenant.id, 'Owner', true);
                setIssuedHeading(null);
                setIssued(code);
              }, t('admin.pairing_once'));
            }}
          >
            {t('admin.issue_owner_code')}
          </button>
        ) : null}
      </div>
      {issued !== null ? (
        <PairingPanel
          code={issued.code}
          link={issued.link}
          expiresAt={issued.expires_at}
          shopName={tenant.display_name}
          heading={issuedHeading}
        />
      ) : null}
      <ReasonDialog
        open={action !== null}
        title={actionTitle}
        body={t('admin.reason_body')}
        confirmLabel={t('admin.confirm')}
        pending={pending}
        targets={reactivateTargets}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        onConfirm={async ({ reason, to }) => {
          const kind = action?.kind;
          if (kind === undefined || kind === null) return false;
          return run(async () => {
            if (kind === 'reactivate')
              await reactivateTenant(tenant.id, reason, to);
            else await postReason(tenant.id, kind, reason);
          }, t('admin.saved'));
        }}
      />
      <HoursDialog
        open={supportOpen}
        pending={pending}
        onOpenChange={setSupportOpen}
        onConfirm={async (reason, hours) =>
          run(async () => {
            const code = await startSupport(tenant.id, reason, hours);
            setIssuedHeading(t('admin.support_code_once'));
            setIssued(code);
          }, t('admin.pairing_once'))
        }
      />
      <AdminConfirm
        open={endOpen}
        onOpenChange={setEndOpen}
        title={t('admin.support_end')}
        body={t('admin.support_end_body')}
        confirmLabel={t('admin.support_end')}
        onConfirm={() => {
          void run(
            () => endSupport(tenant.id).then(() => undefined),
            t('admin.support_ended'),
          );
        }}
      />
      <EditDialog
        open={edit}
        detail={detail}
        pending={pending}
        onOpenChange={setEdit}
        onSave={(body) =>
          run(
            () => patchTenant(tenant.id, body).then(() => undefined),
            t('admin.saved'),
          )
        }
      />
    </div>
  );
}

function EditDialog({
  open,
  detail,
  pending,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  detail: TenantDetail;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (body: {
    display_name?: string;
    owner_email?: string | null;
    daily_write_budget?: number;
    poll_after_ms?: number;
    note?: string;
  }) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const nameRef = useRef<HTMLInputElement>(null);
  const tenant = detail.tenant;
  const [name, setName] = useState(tenant.display_name);
  const [email, setEmail] = useState(tenant.owner_email ?? '');
  const [budget, setBudget] = useState(String(tenant.daily_write_budget));
  const [seconds, setSeconds] = useState(
    String(Math.round(tenant.poll_after_ms / 1000)),
  );
  const [note, setNote] = useState(tenant.note);
  useEffect(() => {
    if (!open) return;
    setName(tenant.display_name);
    setEmail(tenant.owner_email ?? '');
    setBudget(String(tenant.daily_write_budget));
    setSeconds(String(Math.round(tenant.poll_after_ms / 1000)));
    setNote(tenant.note);
  }, [open, tenant]);
  const budgetN = Number(budget);
  const secondsN = Number(seconds);
  const nameOk = name.trim().length >= 1 && name.trim().length <= 60;
  const budgetOk =
    Number.isInteger(budgetN) && budgetN >= 0 && budgetN <= 100_000;
  const pollOk =
    Number.isInteger(secondsN) && secondsN >= 15 && secondsN <= 3600;
  const nextEmail = email.trim().toLowerCase();
  const emailOk = nextEmail === '' || EMAIL_RE.test(nextEmail);
  return (
    <Modal
      open={open}
      title={t('admin.edit_title')}
      onClose={() => {
        onOpenChange(false);
      }}
      initialFocus={nameRef}
    >
      <Field id="edit-name" label={t('admin.display_name')}>
        <input
          ref={nameRef}
          id="edit-name"
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-3"
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field
        id="edit-email"
        label={t('admin.owner_email')}
        hint={t('admin.owner_email_hint')}
      >
        <input
          id="edit-email"
          type="email"
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-3"
          value={email}
          aria-describedby="edit-email-hint"
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Field id="edit-budget" label={t('admin.budget')}>
        <input
          id="edit-budget"
          inputMode="numeric"
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-3 font-mono"
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
        />
      </Field>
      <Field id="edit-poll" label={t('admin.poll')}>
        <input
          id="edit-poll"
          inputMode="numeric"
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-3 font-mono"
          value={seconds}
          onChange={(event) => setSeconds(event.target.value)}
        />
      </Field>
      <Field id="edit-note" label={t('admin.note')}>
        <textarea
          id="edit-note"
          className="min-h-20 w-full rounded-control border border-border-strong bg-surface px-3 py-2"
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      <button
        type="button"
        className={primaryBtn}
        data-confirm="true"
        disabled={!nameOk || !budgetOk || !pollOk || !emailOk || pending}
        onClick={() => {
          const body: {
            display_name?: string;
            owner_email?: string | null;
            daily_write_budget?: number;
            poll_after_ms?: number;
            note?: string;
          } = {};
          const display = name.trim();
          if (display !== tenant.display_name) body.display_name = display;
          if (nextEmail === '' && tenant.owner_email !== null)
            body.owner_email = null;
          else if (nextEmail !== '' && nextEmail !== tenant.owner_email) {
            body.owner_email = nextEmail;
          }
          if (budgetN !== tenant.daily_write_budget)
            body.daily_write_budget = budgetN;
          if (secondsN * 1000 !== tenant.poll_after_ms)
            body.poll_after_ms = secondsN * 1000;
          if (note !== tenant.note) body.note = note;
          void onSave(body).then((ok) => {
            if (ok) onOpenChange(false);
          });
        }}
      >
        {t('admin.save')}
      </button>
      <button
        type="button"
        className={quietBtn}
        onClick={() => {
          onOpenChange(false);
        }}
      >
        {t('common.cancel')}
      </button>
    </Modal>
  );
}
