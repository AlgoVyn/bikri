import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StoreIcon } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  AdminApiError,
  addShopRequestEmail,
  adminErrorMessage,
  approveShopRequest,
  checkShopRequestEmail,
  getShopRequest,
  manualVerifyShopRequestEmail,
  rejectShopRequest,
  reopenShopRequest,
} from './api.ts';
import { adminHref, formatWhen } from './format.ts';
import type { ApproveShopRequestResult } from './types.ts';
import {
  AdminErrorState,
  dangerBtn,
  inputClass,
  Modal,
  PairingPanel,
  Panel,
  primaryBtn,
  quietBtn,
} from './ui.tsx';
import { useAdminQuery } from './useAdminQuery.ts';

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-surface-2 text-text-muted',
  awaiting_email: 'bg-warning-subtle text-warning-subtle-ink',
  email_verified: 'bg-primary-subtle text-primary-subtle-ink',
  approving: 'bg-warning-subtle text-warning-subtle-ink',
  approved: 'bg-success-subtle text-success-subtle-ink',
  rejected: 'bg-danger-subtle text-danger-subtle-ink',
  failed: 'bg-danger-subtle text-danger-subtle-ink',
};

function Status({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-small font-medium ${STATUS_TONE[status] ?? STATUS_TONE.pending}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {t(`admin.request_status_${status}`)}
    </span>
  );
}

function Field({
  label,
  value,
  className = '',
}: {
  label: string;
  value: string | number | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-small text-text-muted">{label}</dt>
      <dd className="break-words">
        {value === null || value === '' ? '—' : value}
      </dd>
    </div>
  );
}

export function RequestPage({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const query = useAdminQuery(`shop-request:${id}`, () => getShopRequest(id));
  const [busy, setBusy] = useState<string | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveResult, setApproveResult] =
    useState<ApproveShopRequestResult | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualNote, setManualNote] = useState('');
  const [routingMissing, setRoutingMissing] = useState(false);

  if (query.data === null) {
    return query.error !== null ? (
      <AdminErrorState message={query.error} onRetry={query.reload} />
    ) : (
      <p className="sr-only">{t('common.loading')}</p>
    );
  }
  const { request, tenant } = query.data;
  const verified = request.email_verified_at !== null;
  const canApprove =
    verified &&
    (request.status === 'email_verified' || request.status === 'failed');

  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (busy !== null) return;
    setBusy(key);
    try {
      await fn();
    } catch (error) {
      if (
        error instanceof AdminApiError &&
        error.code === 'EMAIL_ROUTING_NOT_CONFIGURED'
      ) {
        setRoutingMissing(true);
        toast.push(t('admin.request_email_not_configured'), 'error');
      } else {
        toast.push(adminErrorMessage(error, t('admin.err_generic')), 'error');
      }
    } finally {
      setBusy(null);
    }
  };

  const addEmail = () =>
    run('email', async () => {
      await addShopRequestEmail(id);
      toast.push(t('admin.request_email_added'));
      query.reload();
    });

  const checkEmail = () =>
    run('check', async () => {
      const result = await checkShopRequestEmail(id);
      toast.push(
        result.verified
          ? t('admin.request_email_verified_toast')
          : t('admin.request_email_not_verified'),
        result.verified ? 'info' : 'error',
      );
      query.reload();
    });

  const manualVerify = () =>
    run('manual', async () => {
      await manualVerifyShopRequestEmail(id, manualNote.trim());
      toast.push(t('admin.request_email_verified_toast'));
      setManualOpen(false);
      setManualNote('');
      query.reload();
    });

  const approve = () =>
    run('approve', async () => {
      const result = await approveShopRequest(id);
      setApproveResult(result);
      setApproveOpen(false);
      toast.push(
        result.already_approved
          ? t('admin.request_approved_existing')
          : t('admin.request_approved'),
      );
      query.reload();
    });

  const reject = () =>
    run('reject', async () => {
      await rejectShopRequest(id, reason.trim());
      setRejectOpen(false);
      setReason('');
      toast.push(t('admin.request_rejected'));
      query.reload();
    });

  const reopen = () =>
    run('reopen', async () => {
      await reopenShopRequest(id, reason.trim());
      setReopenOpen(false);
      setReason('');
      toast.push(t('admin.request_reopened'));
      query.reload();
    });

  const emailText = verified
    ? t('admin.request_email_verified')
    : request.cloudflare_address_id
      ? t('admin.request_email_sent')
      : t('admin.request_email_not_added');

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<StoreIcon />}
        title={request.shop_name}
        subtitle={`${request.owner_name} · ${request.email}`}
        actions={
          <a href={adminHref('/admin/requests')} className={quietBtn}>
            {t('admin.request_back')}
          </a>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Status status={request.status} />
        <span className="text-small text-text-muted">
          {t('admin.request_created')}{' '}
          {formatWhen(request.created_at, i18n.language)}
        </span>
      </div>

      {approveResult?.owner_code ? (
        <PairingPanel
          code={approveResult.owner_code.code}
          link={approveResult.owner_code.link}
          expiresAt={approveResult.owner_code.expires_at}
          shopName={request.shop_name}
        />
      ) : null}
      {approveResult && !approveResult.invite_email_sent ? (
        <p className="rounded-control border border-warning bg-warning-subtle p-3 text-small text-warning-subtle-ink">
          {t('admin.request_invite_not_sent')}
        </p>
      ) : null}
      {approveResult?.already_approved ? (
        <p className="rounded-control bg-surface-2 p-3 text-small">
          {t('admin.request_approved_existing')}
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <Panel title={t('admin.request_details')}>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label={t('admin.request_shop')} value={request.shop_name} />
            <Field
              label={t('admin.request_owner')}
              value={request.owner_name}
            />
            <Field label={t('admin.request_email')} value={request.email} />
            <Field label={t('admin.request_phone')} value={request.phone} />
            <Field label={t('admin.request_city')} value={request.city} />
            <Field
              label={t('admin.request_business_type')}
              value={
                request.business_type
                  ? t(`admin.request_business_${request.business_type}`, {
                      defaultValue: request.business_type,
                    })
                  : '—'
              }
            />
            <Field
              className="sm:col-span-2"
              label={t('admin.request_note')}
              value={request.note}
            />
            <Field
              label={t('admin.request_reviewed')}
              value={
                request.reviewed_by
                  ? `${request.reviewed_by} · ${formatWhen(
                      request.reviewed_at ?? request.updated_at,
                      i18n.language,
                    )}`
                  : null
              }
            />
            {request.reject_reason ? (
              <Field
                label={t('admin.request_reject_reason')}
                value={request.reject_reason}
              />
            ) : null}
            {request.last_error ? (
              <Field
                className="sm:col-span-2"
                label={t('admin.request_last_error')}
                value={request.last_error}
              />
            ) : null}
          </dl>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel
            title={t('admin.request_email_section')}
            description={t('admin.request_email_hint')}
          >
            <div className="flex flex-col gap-3">
              <p className="text-small">{emailText}</p>
              {verified ? (
                <p className="rounded-control bg-success-subtle p-2 text-small text-success-subtle-ink">
                  {t('admin.request_email_verified')}
                </p>
              ) : request.cloudflare_address_id ? (
                <button
                  type="button"
                  className={primaryBtn}
                  data-testid="request-email-check"
                  disabled={busy !== null}
                  onClick={() => void checkEmail()}
                >
                  {t('admin.request_email_check')}
                </button>
              ) : (
                <button
                  type="button"
                  className={primaryBtn}
                  data-testid="request-email-add"
                  disabled={busy !== null}
                  onClick={() => void addEmail()}
                >
                  {t('admin.request_email_add')}
                </button>
              )}
              {routingMissing && !verified ? (
                <div className="rounded-control border border-warning bg-warning-subtle p-3 text-small text-warning-subtle-ink">
                  <p>{t('admin.request_email_manual_hint')}</p>
                  <button
                    type="button"
                    className={quietBtn}
                    data-testid="request-email-manual"
                    onClick={() => setManualOpen(true)}
                  >
                    {t('admin.request_email_manual_button')}
                  </button>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel title={t('admin.request_actions')}>
            <div className="flex flex-col gap-2">
              {request.status === 'rejected' ? (
                <button
                  type="button"
                  className={primaryBtn}
                  data-testid="request-reopen"
                  disabled={busy !== null}
                  onClick={() => {
                    setReason('');
                    setReopenOpen(true);
                  }}
                >
                  {t('admin.request_reopen')}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={primaryBtn}
                    data-testid="request-approve"
                    disabled={!canApprove || busy !== null}
                    onClick={() => setApproveOpen(true)}
                  >
                    {t('admin.request_approve')}
                  </button>
                  {!verified ? (
                    <p className="text-small text-text-muted">
                      {t('admin.request_verify_first')}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className={dangerBtn}
                    data-testid="request-reject"
                    disabled={busy !== null || request.status === 'approved'}
                    onClick={() => {
                      setReason('');
                      setRejectOpen(true);
                    }}
                  >
                    {t('admin.request_reject')}
                  </button>
                </>
              )}
              {tenant ? (
                <a
                  href={adminHref(`/admin/tenants/${tenant.id}`)}
                  className={quietBtn}
                >
                  {t('admin.request_open_tenant')}
                </a>
              ) : null}
            </div>
          </Panel>
        </div>
      </div>

      <Modal
        open={approveOpen}
        title={t('admin.request_approve_title')}
        description={t('admin.request_approve_body', {
          shop: request.shop_name,
          email: request.email,
        })}
        onClose={() => setApproveOpen(false)}
      >
        <p className="text-small text-text-muted">
          {t('admin.request_slug_budget_hint')}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={quietBtn}
            onClick={() => setApproveOpen(false)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={primaryBtn}
            data-testid="request-approve-confirm"
            disabled={busy !== null}
            onClick={() => void approve()}
          >
            {t('admin.request_approve_confirm')}
          </button>
        </div>
      </Modal>

      <Modal
        open={rejectOpen}
        title={t('admin.request_reject_title')}
        description={t('admin.request_reject_body', {
          shop: request.shop_name,
        })}
        onClose={() => setRejectOpen(false)}
      >
        <label className="flex flex-col gap-1 text-small">
          <span>{t('admin.request_reject_reason')}</span>
          <input
            className={inputClass}
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={quietBtn}
            onClick={() => setRejectOpen(false)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={dangerBtn}
            disabled={reason.trim().length === 0 || busy !== null}
            onClick={() => void reject()}
          >
            {t('admin.request_reject_confirm')}
          </button>
        </div>
      </Modal>

      <Modal
        open={reopenOpen}
        title={t('admin.request_reopen_title')}
        description={t('admin.request_reopen_body')}
        onClose={() => setReopenOpen(false)}
      >
        <label className="flex flex-col gap-1 text-small">
          <span>{t('admin.request_reopen_reason')}</span>
          <input
            className={inputClass}
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={quietBtn}
            onClick={() => setReopenOpen(false)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={primaryBtn}
            disabled={reason.trim().length === 0 || busy !== null}
            onClick={() => void reopen()}
          >
            {t('admin.request_reopen_confirm')}
          </button>
        </div>
      </Modal>

      <Modal
        open={manualOpen}
        title={t('admin.request_email_manual_title')}
        description={t('admin.request_email_manual_hint')}
        onClose={() => setManualOpen(false)}
      >
        <label className="flex flex-col gap-1 text-small">
          <span>{t('admin.request_email_manual_note')}</span>
          <textarea
            className={`${inputClass} min-h-20`}
            data-testid="request-email-manual-note"
            value={manualNote}
            maxLength={200}
            onChange={(event) => setManualNote(event.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={quietBtn}
            onClick={() => setManualOpen(false)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={primaryBtn}
            data-testid="request-email-manual-submit"
            disabled={manualNote.trim().length === 0 || busy !== null}
            onClick={() => void manualVerify()}
          >
            {t('admin.request_email_manual_button')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
