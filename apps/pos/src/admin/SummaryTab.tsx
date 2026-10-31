import {
  Badge,
  Box,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
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
  Field,
  HoursDialog,
  Modal,
  PairingPanel,
  Panel,
  ReasonDialog,
  StatusBadge,
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

  const total = detail.usage.reduce((sum, day) => sum + day.rows_written, 0);

  return (
    <Stack gap="md">
      {tenant.owner_email === null ? (
        <Paper p="sm" role="status" bg="var(--mantine-color-warning-subtle)">
          <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
            {t('admin.owner_email_missing')}
          </Text>
        </Paper>
      ) : null}
      {detail.support ? (
        <Paper p="md" role="status" bg="var(--color-info-subtle)">
          <Group
            justify="space-between"
            align="flex-start"
            gap="sm"
            wrap="wrap"
          >
            <Box>
              <Text fw={500} c="var(--color-info-subtle-ink)">
                {t('admin.support_active', {
                  when: formatWhen(detail.support.until, lang),
                })}
              </Text>
              <Text size="sm" c="var(--color-info-subtle-ink)">
                {t('admin.support_reason', { reason: detail.support.reason })}
              </Text>
            </Box>
            <Button
              type="button"
              color="danger"
              onClick={() => setEndOpen(true)}
            >
              {t('admin.support_end')}
            </Button>
          </Group>
        </Paper>
      ) : null}

      <SimpleGrid
        cols={{ base: 1, xl: 2 }}
        spacing="md"
        style={{ alignItems: 'start' }}
      >
        <Panel
          title={t('admin.tenant_status')}
          description={t('admin.tenant_status_hint')}
        >
          <Stack gap="sm" align="flex-start">
            <StatusBadge status={status} />
            <Text size="sm">
              {tenant.status_changed_at === null
                ? t('admin.status_since_never')
                : t('admin.status_since', {
                    status: t(statusLabelKey(status)),
                    when: formatWhen(tenant.status_changed_at, lang),
                  })}
            </Text>
            <Text size="sm" c="dimmed">
              {tenant.status_reason === ''
                ? t('admin.status_reason_none')
                : t('admin.status_reason', {
                    reason: tenant.status_reason,
                  })}
            </Text>
            {tenant.status_changed_by !== null ? (
              <Text size="sm" c="dimmed">
                {t('admin.status_by', { by: tenant.status_changed_by })}
              </Text>
            ) : null}
          </Stack>
        </Panel>

        <Panel
          title={t('admin.tenant_profile')}
          description={t('admin.tenant_profile_hint')}
        >
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <Box>
              <Text size="sm" c="dimmed">
                {t('admin.shop_name')}
              </Text>
              <Text fw={500}>
                {detail.shop_name ?? t('admin.setup_pending')}
              </Text>
            </Box>
            <Box>
              <Text size="sm" c="dimmed">
                {t('admin.owner_email')}
              </Text>
              <Text fw={500} style={{ wordBreak: 'break-all' }}>
                {tenant.owner_email ?? t('admin.never')}
              </Text>
            </Box>
            <Box>
              <Text size="sm" c="dimmed">
                {t('admin.created')}
              </Text>
              <Text>{formatWhen(tenant.created_at, lang)}</Text>
            </Box>
            <Box>
              <Text size="sm" c="dimmed">
                {t('admin.budget')}
              </Text>
              <Text>{formatCount(tenant.daily_write_budget, lang)}</Text>
            </Box>
            <Box>
              <Text size="sm" c="dimmed">
                {t('admin.poll')}
              </Text>
              <Text>
                {t('admin.poll_ms', {
                  seconds: Math.round(tenant.poll_after_ms / 1000),
                })}
              </Text>
            </Box>
            <Box>
              <Text size="sm" c="dimmed">
                {t('admin.restore_epoch')}
              </Text>
              <Text size="sm" ff="monospace">
                {tenant.restore_epoch}
              </Text>
            </Box>
            <Box>
              <Text size="sm" c="dimmed">
                {t('admin.last_restore')}
              </Text>
              <Text>
                {tenant.restore_point_at > 0
                  ? formatWhen(tenant.restore_point_at, lang)
                  : t('admin.never')}
              </Text>
            </Box>
            <Box>
              <Text size="sm" c="dimmed">
                {t('admin.last_export')}
              </Text>
              <Text>
                {tenant.last_owner_export_at === null
                  ? t('admin.never')
                  : formatWhen(tenant.last_owner_export_at, lang)}
              </Text>
            </Box>
            {tenant.note !== '' ? (
              <Box style={{ gridColumn: '1 / -1' }}>
                <Text size="sm" c="dimmed">
                  {t('admin.note')}
                </Text>
                <Text style={{ whiteSpace: 'pre-wrap' }}>{tenant.note}</Text>
              </Box>
            ) : null}
          </SimpleGrid>
        </Panel>
      </SimpleGrid>

      <Panel
        title={t('admin.usage_7d')}
        description={t('admin.tenant_usage_hint')}
        actions={
          <Text size="sm" c="dimmed">
            {t('admin.usage_total', {
              value: formatCount(total, lang),
            })}
          </Text>
        }
      >
        {detail.usage.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('admin.usage_empty')}
          </Text>
        ) : (
          <ul className="flex h-36 items-end gap-2 border-b border-border pb-2">
            {detail.usage.map((day) => (
              <li
                key={day.day}
                className="flex h-full flex-1 flex-col justify-end"
              >
                <div
                  className="mx-auto w-full max-w-24 rounded-t-control bg-primary transition-colors hover:bg-primary-hover"
                  style={{
                    height: `${barPercent(day.rows_written, maxWrite)}%`,
                    minHeight: day.rows_written > 0 ? '4px' : '2px',
                    backgroundColor:
                      day.rows_written > 0
                        ? undefined
                        : 'var(--color-surface-2)',
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
      </Panel>

      <Panel title={t('admin.history')} description={t('admin.history_hint')}>
        {detail.status_history.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('admin.history_empty')}
          </Text>
        ) : (
          <ol className="flex flex-col divide-y divide-border">
            {detail.status_history.map((item) => (
              <li
                key={`${item.at}-${item.to ?? ''}`}
                className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={item.from ?? ''} />
                  <span
                    aria-hidden="true"
                    className="text-text-muted rtl:rotate-180"
                  >
                    →
                  </span>
                  <StatusBadge status={item.to ?? ''} />
                  <span className="ms-auto text-small text-text-muted tabular-nums">
                    {formatWhen(item.at, lang)}
                  </span>
                </div>
                <p className="text-small">
                  {item.reason ?? t('admin.status_reason_none')}
                </p>
                {item.by !== undefined ? (
                  <p className="text-small text-text-muted">
                    {t('admin.status_by', { by: item.by })}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel
        title={t('admin.tenant_actions')}
        description={t('admin.tenant_actions_hint')}
      >
        <Group gap="sm" wrap="wrap">
          <Button type="button" variant="default" onClick={() => setEdit(true)}>
            {t('admin.edit')}
          </Button>
          {status === 'active' ? (
            <Button
              type="button"
              variant="default"
              onClick={() => setAction({ kind: 'read-only' })}
            >
              {t('admin.make_readonly')}
            </Button>
          ) : null}
          {status === 'active' || status === 'read_only' ? (
            <Button
              type="button"
              variant="default"
              onClick={() => setAction({ kind: 'suspend' })}
            >
              {t('admin.suspend')}
            </Button>
          ) : null}
          {status === 'suspended' || status === 'read_only' ? (
            <Button
              type="button"
              onClick={() => setAction({ kind: 'reactivate' })}
            >
              {t('admin.reactivate')}
            </Button>
          ) : null}
          {supportable && detail.support === null ? (
            <Button
              type="button"
              variant="default"
              onClick={() => setSupportOpen(true)}
            >
              {t('admin.support_start')}
            </Button>
          ) : null}
          {status !== 'deleting' ? (
            <Button
              type="button"
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
            </Button>
          ) : null}
        </Group>
      </Panel>

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
    </Stack>
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
      <Group justify="flex-end" gap="sm">
        <Button
          type="button"
          variant="default"
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
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
        </Button>
      </Group>
    </Modal>
  );
}
