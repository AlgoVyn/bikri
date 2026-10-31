import {
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  Modal as MantineModal,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
} from '@mantine/core';
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
import { countdownParts, formatWhen, statusLabelKey } from './format.ts';

const dialogClass =
  'fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(28rem,calc(100%-2rem))] flex-col gap-4 overflow-y-auto rounded-modal border-0 bg-surface p-4 text-text shadow-modal backdrop:bg-text/40';

/** Shared operator dialog on the same Mantine modal as the till. */
export function Modal({
  open,
  title,
  description,
  onClose,
  initialFocus: _initialFocus,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <MantineModal
      opened={open}
      onClose={onClose}
      title={title}
      centered
      size="md"
      radius="lg"
    >
      <Stack gap="md">
        {description !== undefined ? (
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        ) : null}
        {children}
      </Stack>
    </MantineModal>
  );
}

export const primaryBtn = buttonPrimary;
export const quietBtn = buttonQuiet;
export const dangerBtn = buttonDanger;

export const inputClass =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text focus:border-primary';

const STATUS_COLOR: Record<string, string> = {
  active: 'success',
  read_only: 'warning',
  suspended: 'danger',
  maintenance: 'warning',
  deleting: 'danger',
  deleted: 'gray',
};

/** Status pill shared by shop tables, tenant headers and device rows. */
export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <Badge
      color={STATUS_COLOR[status] ?? 'gray'}
      variant="light"
      radius="xl"
      tt="none"
      leftSection={
        <Box
          aria-hidden="true"
          w={6}
          h={6}
          style={{ borderRadius: 999, background: 'currentColor' }}
        />
      }
    >
      {t(statusLabelKey(status))}
    </Badge>
  );
}

/** Card with an optional heading row, used on every operator page. */
export function Panel({
  title,
  description,
  actions,
  children,
  className = '',
  bodyClassName = 'p-4',
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const id = useId();
  return (
    <Paper
      component="section"
      withBorder
      className={className}
      aria-labelledby={title !== undefined ? id : undefined}
    >
      {title !== undefined ? (
        <Group
          justify="space-between"
          align="flex-start"
          gap="sm"
          px="md"
          py="sm"
          wrap="wrap"
          style={{
            borderBottom: '1px solid var(--mantine-color-default-border)',
          }}
        >
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Title order={2} id={id}>
              {title}
            </Title>
            {description !== undefined ? (
              <Text size="sm" c="dimmed">
                {description}
              </Text>
            ) : null}
          </Stack>
          {actions !== undefined ? (
            <Group gap="sm" wrap="wrap" justify="flex-end">
              {actions}
            </Group>
          ) : null}
        </Group>
      ) : null}
      <Box className={bodyClassName}>{children}</Box>
    </Paper>
  );
}

/** Headline number on the overview. */
export function StatCard({
  label,
  value,
  hint,
  compact = false,
}: {
  label: string;
  value: string;
  hint?: string;
  compact?: boolean;
}) {
  return (
    <Paper p="md" withBorder>
      <Text size="sm" fw={500} c="dimmed">
        {label}
      </Text>
      <Text
        mt={4}
        fw={650}
        fz={compact ? 'lg' : 32}
        lh={1.15}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </Text>
      {hint !== undefined ? (
        <Text mt={2} size="sm" c="dimmed">
          {hint}
        </Text>
      ) : null}
    </Paper>
  );
}

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
    <Stack gap={4}>
      <Text component="label" htmlFor={id} size="sm">
        {label}
      </Text>
      {children}
      {hint !== undefined ? (
        <Text id={`${id}-hint`} size="sm" c="dimmed">
          {hint}
        </Text>
      ) : null}
    </Stack>
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
  const tone = over ? 'danger' : warn ? 'warning' : 'brand';
  const limit = max > 0 ? max : Math.max(value, 1);
  return (
    <Box>
      <Group justify="space-between" gap="sm">
        <Text size="sm">{label}</Text>
        <Text size="sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {valueText}
        </Text>
      </Group>
      <Progress
        mt={4}
        value={Math.min(100, (value / limit) * 100)}
        size="sm"
        color={tone}
        aria-label={`${label}: ${valueText}`}
      />
    </Box>
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
    <Paper component="section" withBorder aria-labelledby="pairing-title">
      <Group
        justify="space-between"
        align="flex-start"
        gap="sm"
        px="md"
        py="sm"
        wrap="wrap"
        style={{
          borderBottom: '1px solid var(--mantine-color-default-border)',
        }}
      >
        <Title order={2} fz="lg" id="pairing-title">
          {heading ?? t('admin.pairing_once')}
        </Title>
        <Badge
          aria-live="polite"
          variant="light"
          color={left.done ? 'danger' : 'warning'}
          tt="none"
          radius="xl"
        >
          {left.done
            ? t('admin.countdown_done')
            : t('admin.countdown', {
                hours: left.hours,
                minutes: left.minutes,
              })}
        </Badge>
      </Group>
      <Stack gap="md" p="md">
        <Paper
          p="md"
          ta="center"
          bg="var(--mantine-color-default-hover)"
          style={{ border: '1px dashed var(--mantine-color-default-border)' }}
        >
          <Text size="sm" fw={500} c="dimmed">
            {t('admin.pairing_code')}
          </Text>
          <Text
            mt={4}
            ff="monospace"
            fz={28}
            fw={600}
            style={{ letterSpacing: '0.18em' }}
            data-testid="pairing-code"
          >
            {code}
          </Text>
          <Text mt={4} size="sm" c="dimmed">
            {t('admin.pairing_help')}
          </Text>
        </Paper>
        <Box>
          <Text size="sm" c="dimmed">
            {t('admin.pairing_link')}
          </Text>
          <Anchor href={link} fw={500} style={{ wordBreak: 'break-all' }}>
            {link}
          </Anchor>
        </Box>
        <Text size="sm" c="dimmed">
          {when}
        </Text>
        <Group
          gap="sm"
          pt="md"
          style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
        >
          <Button
            type="button"
            variant="default"
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
          </Button>
          <Button
            component="a"
            href={waHref}
            target="_blank"
            rel="noreferrer"
            variant="default"
          >
            {t('admin.wa')}
          </Button>
        </Group>
      </Stack>
    </Paper>
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
