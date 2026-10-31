import type { PrintJob } from '@bikri/db';
import {
  Box,
  Button,
  Divider,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PrinterIcon } from '../components/icons.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { setKv } from '../data/kv.ts';
import {
  cancelPrintJob,
  cancelQueuedPrintJobs,
  retryPrintJob,
} from '../data/printJobs.ts';
import type { PrinterKv } from '../data/receipt.ts';
import { browserPrintDeps } from '../print/printDeps.ts';
import { errorCode, openDrawer, printTestPage } from '../print/printService.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { SettingsPageLayout } from './Layout.tsx';
import { PrinterWizard } from './PrinterWizard.tsx';

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" mih={44} gap="sm">
      <Text size="sm">{label}</Text>
      <Switch
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </Group>
  );
}

function timeOf(ms: number, lang: string): string {
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK' : 'en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

/** Settings → Printer (screens/17, this device only). */
export function PrinterPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { staff, role, can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const printer = useLiveQuery(
    async () =>
      ((await getDb().kv.get('printer'))?.value ?? null) as PrinterKv | null,
    [],
  );
  const jobs = useLiveQuery(async () => {
    const db = getDb();
    const list = (await db.print_jobs
      .orderBy('created_at')
      .reverse()
      .limit(50)
      .toArray()) as PrintJob[];
    const sales = await db.sales.bulkGet(list.map((j) => j.sale_id ?? ''));
    return list.map((j, i) => ({
      job: j,
      invoice: sales[i] ? String(sales[i]?.invoice_no) : null,
    }));
  }, []);
  const queued = jobs?.filter(({ job }) => job.status === 'queued').length ?? 0;
  const [wizard, setWizard] = useState(false);
  // Cashiers' settings.device covers display and language only (05 §6).
  const canUse = can('settings.device');
  const editable = canUse && role !== 'cashier';
  const deps = browserPrintDeps();

  const update = (p: Partial<PrinterKv>) =>
    void setKv(getDb(), 'printer', { ...printer, ...p });

  const run = async (what: 'test' | 'drawer') => {
    try {
      if (what === 'drawer' && readOnly) {
        toast.push(t('tenant.readOnly.blocked'), 'error');
        return;
      }
      if (what === 'test') await printTestPage(getDb(), printer ?? {}, deps);
      else await openDrawer(getDb(), deps, staff?.id ?? null);
      toast.push(
        t(what === 'test' ? 'printer.test_sent' : 'printer.drawer_opened'),
        'info',
      );
    } catch (err) {
      toast.push(t(`print.err_${errorCode(err)}`), 'error');
    }
  };

  if (printer === undefined) return null;
  const lastFailed = jobs?.find((j) => j.job.status === 'failed');
  const where =
    printer?.transport === 'usb'
      ? (printer.usb?.name ?? 'USB')
      : printer?.transport === 'serial'
        ? t('printer.transport_serial')
        : t('printer.transport_system');

  return (
    <SettingsPageLayout title={t('printer.title')} icon={<PrinterIcon />}>
      <Paper withBorder p="lg" aria-labelledby="printer-status">
        <Stack gap="sm">
          <Title order={2} fz="lg" id="printer-status">
            {t('printer.status')}
          </Title>
          <Text data-testid="printer-summary">
            {printer?.transport
              ? t('printer.summary', {
                  where,
                  mm: printer.paper_mm ?? 80,
                  chars:
                    printer.chars_per_line ??
                    (printer.paper_mm === 58 ? 32 : 48),
                })
              : t('printer.none')}
          </Text>
          {lastFailed ? (
            <Text size="sm" c="danger">
              {t('printer.last_error', {
                reason: t(`print.err_${lastFailed.job.error ?? 'FAILED'}`),
              })}
            </Text>
          ) : null}
          <Text size="sm" c="dimmed">
            {t('printer.never_loses')}
          </Text>
          {wizard ? null : editable ? (
            <Group gap="sm">
              <Button type="button" onClick={() => setWizard(true)}>
                {t('printer.setup')}
              </Button>
              {printer?.transport ? (
                <>
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => void run('test')}
                  >
                    {t('printer.test_print')}
                  </Button>
                  {editable &&
                  can('drawer.open') &&
                  !readOnly &&
                  printer.transport !== 'system' ? (
                    <Button
                      type="button"
                      variant="default"
                      onClick={() => void run('drawer')}
                    >
                      {t('printer.open_drawer')}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </Group>
          ) : (
            <Text size="sm" c="dimmed">
              {t('printer.ask_owner')}
            </Text>
          )}
          {!editable && canUse && printer?.transport ? (
            <Button
              type="button"
              variant="default"
              onClick={() => void run('test')}
              style={{ alignSelf: 'flex-start' }}
            >
              {t('printer.test_print')}
            </Button>
          ) : null}
          <Box
            component="details"
            style={{ fontSize: 'var(--mantine-font-size-sm)' }}
          >
            <Box
              component="summary"
              style={{
                cursor: 'pointer',
                color: 'var(--mantine-color-brand-7)',
              }}
            >
              {t('printer.which')}
            </Box>
            <Text mt={4} size="sm">
              {t('printer.which_body')}
            </Text>
          </Box>
        </Stack>
      </Paper>

      {wizard ? (
        <PrinterWizard current={printer} onDone={() => setWizard(false)} />
      ) : null}

      {printer?.transport && editable && !wizard ? (
        <Paper withBorder p="lg" aria-labelledby="printer-options">
          <Stack gap="xs">
            <Title order={2} fz="lg" id="printer-options">
              {t('printer.options')}
            </Title>
            <Toggle
              label={t('printer.auto_print')}
              checked={printer.auto_print !== false}
              onChange={(v) => update({ auto_print: v })}
            />
            <Toggle
              label={t('printer.print_logo')}
              checked={printer.print_logo !== false}
              onChange={(v) => update({ print_logo: v })}
            />
            <Toggle
              label={t('printer.print_qr')}
              checked={printer.qr === true}
              onChange={(v) => update({ qr: v })}
            />
            <Toggle
              label={t('printer.drawer_cash')}
              checked={printer.drawer !== false}
              onChange={(v) => update({ drawer: v })}
            />
            <Group justify="space-between" wrap="nowrap" mih={44} gap="sm">
              <Text size="sm">{t('printer.copies')}</Text>
              <NativeSelect
                aria-label={t('printer.copies')}
                value={printer.copies ?? 1}
                onChange={(event) =>
                  update({ copies: Number(event.currentTarget.value) })
                }
                data={[1, 2, 3].map((n) => ({
                  value: String(n),
                  label: String(n),
                }))}
                w={96}
              />
            </Group>
            <Group justify="space-between" wrap="nowrap" mih={44} gap="sm">
              <Text size="sm">{t('printer.drawer_pin')}</Text>
              <NativeSelect
                aria-label={t('printer.drawer_pin')}
                value={printer.drawer_pin ?? 2}
                onChange={(event) =>
                  update({
                    drawer_pin: Number(event.currentTarget.value) as 2 | 5,
                  })
                }
                data={[
                  { value: '2', label: '2' },
                  { value: '5', label: '5' },
                ]}
                w={96}
              />
            </Group>
            <Group justify="space-between" wrap="nowrap" mih={44} gap="sm">
              <Text size="sm">{t('printer.cut')}</Text>
              <NativeSelect
                aria-label={t('printer.cut')}
                value={printer.cut ?? 'partial'}
                onChange={(event) =>
                  update({
                    cut: event.currentTarget.value as PrinterKv['cut'],
                  })
                }
                data={(['partial', 'full', 'none'] as const).map((c) => ({
                  value: c,
                  label: t(`printer.cut_${c}`),
                }))}
                w={140}
              />
            </Group>
          </Stack>
        </Paper>
      ) : null}

      <Stack gap="sm" aria-labelledby="recent-prints">
        <Group justify="space-between" gap="sm" wrap="wrap">
          <Title order={2} fz="lg" id="recent-prints">
            {t('printer.recent')}
          </Title>
          {queued > 0 ? (
            <Button
              type="button"
              variant="default"
              onClick={() => {
                void cancelQueuedPrintJobs(getDb()).then((count) =>
                  toast.push(t('printer.cancelled_many', { count }), 'info'),
                );
              }}
            >
              {t('printer.cancel_waiting', { count: queued })}
            </Button>
          ) : null}
        </Group>
        {jobs && jobs.length === 0 ? (
          <Text c="dimmed">{t('printer.recent_empty')}</Text>
        ) : null}
        <Paper withBorder>
          <Box
            component="ul"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {jobs?.map(({ job, invoice }, index) => (
              <Box component="li" key={job.id} data-testid="print-job">
                {index > 0 ? <Divider /> : null}
                <Group gap="sm" p="sm" wrap="wrap">
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm">
                      {invoice
                        ? t('printer.job_bill', { invoice })
                        : t(`printer.kind_${job.kind}`)}
                      {job.reprint ? ` · ${t('printer.reprint')}` : ''}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {timeOf(job.created_at, i18n.language)}
                    </Text>
                  </Box>
                  <Text
                    size="sm"
                    c={job.status === 'failed' ? 'danger' : 'dimmed'}
                  >
                    {job.status === 'failed'
                      ? t(`print.err_${job.error ?? 'FAILED'}`)
                      : t(`printer.status_${job.status}`)}
                  </Text>
                  {job.status === 'failed' ? (
                    <Button
                      type="button"
                      variant="default"
                      size="compact-sm"
                      onClick={() => void retryPrintJob(getDb(), job.id)}
                    >
                      {t('done.retry')}
                    </Button>
                  ) : null}
                  {job.status === 'queued' ? (
                    <Button
                      type="button"
                      variant="default"
                      size="compact-sm"
                      onClick={() => {
                        void cancelPrintJob(getDb(), job.id).then(() =>
                          toast.push(t('printer.cancelled'), 'info'),
                        );
                      }}
                    >
                      {t('printer.cancel')}
                    </Button>
                  ) : null}
                </Group>
              </Box>
            ))}
          </Box>
        </Paper>
      </Stack>
    </SettingsPageLayout>
  );
}
