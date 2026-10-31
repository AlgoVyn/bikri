import { businessDate, computeDayClose, newId } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { ClockIcon } from '../components/icons.tsx';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { PageLoading } from '../components/PageLoading';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import {
  closeDay,
  dayCloseCsv,
  dayCloseData,
  queueDayClosePrint,
} from '../data/dayClose.ts';
import { loadDayCloseReceipt } from '../data/dayCloseReceipt.ts';
import { getDb } from '../data/db.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { downloadText } from '../lib/download.ts';
import { dayCloseReceipt, receiptPdf } from '../print/receiptFiles.ts';
import { downloadBlob } from '../print/receiptImage.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';

const COMMEMORATIVE = 75;

export function DayClosePage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const { staff, can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const [notes, setNotes] = useState<Record<number, number>>({});
  const [show75, setShow75] = useState(false);
  const [mode, setMode] = useState<'notes' | 'total'>('notes');
  const [countTouched, setCountTouched] = useState(false);
  const [totalInput, setTotalInput] = useState<number | null>(null);
  const [opening, setOpening] = useState(0);
  const [note, setNote] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [closed, setClosed] = useState<Awaited<
    ReturnType<typeof closeDay>
  > | null>(null);
  const [confirmAgain, setConfirmAgain] = useState(false);
  const [pending, setPending] = useState(false);

  const data = useLiveQuery(async () => {
    const db = getDb();
    const device = await deviceInfo(db);
    if (!device) return null;
    const tz = await shopTimeZone(db);
    return {
      ...(await dayCloseData(db, device.id)),
      deviceName: String(device.name ?? device.code ?? ''),
      tz,
      today: businessDate(Date.now(), tz),
    };
  }, []);

  useEffect(() => {
    if (data?.firstClose) setOpening(data.openingCash);
  }, [data?.firstClose, data?.openingCash]);

  if (!can('dayclose.create'))
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.dayclose.no_permission')}
      </p>
    );
  if (data === null)
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.dayclose.no_device')}
      </p>
    );
  if (!data) return <PageLoading compact />;

  const notesTotal = Object.entries(notes).reduce(
    (sum, [value, count]) => sum + Number(value) * count * 100,
    0,
  );
  const counted = mode === 'notes' ? notesTotal : (totalInput ?? 0);
  const result = computeDayClose({
    ...data.components,
    opening_cash: data.firstClose ? opening : data.components.opening_cash,
    counted_cash: counted,
  });
  const blind = !can('dayclose.view_expected') && !revealed;
  const resetForm = () => {
    setNotes({});
    setTotalInput(null);
    setNote('');
    setRevealed(false);
    setMode('notes');
    setCountTouched(false);
    setOpening(data?.firstClose ? data.openingCash : 0);
  };
  const noteNeeded =
    Math.abs(result.difference) >= 10_000 && note.trim() === '';
  const period = (at: number) =>
    new Intl.DateTimeFormat(
      i18n.language === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK',
      {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: data.tz,
      },
    ).format(at);

  const close = async (force = false) => {
    if (pending || noteNeeded) return;
    if (data.recentClose && !force) {
      setConfirmAgain(true);
      return;
    }
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      const row = await closeDay(
        db,
        {
          dayCloseId: newId(),
          countedCash: counted,
          denominations: mode === 'notes' ? notes : null,
          note,
          openingCash: data.firstClose ? opening : undefined,
        },
        ctx,
      );
      setClosed(row);
      toast.push(t('office.dayclose.closed'));
      void import('../sync/engine.ts')
        .then((m) => m.syncNow())
        .catch(() => undefined);
    } catch (err) {
      toast.push(
        err instanceof Error ? err.message : t('errors.generic'),
        'error',
      );
    } finally {
      setPending(false);
      setConfirmAgain(false);
    }
  };

  const exportCsv = async () => {
    if (!closed) return;
    const receipt = await loadDayCloseReceipt(getDb(), String(closed.id));
    if (!receipt) return;
    downloadText(
      `day-close-${String(closed.business_date)}.csv`,
      dayCloseCsv(receipt, String(closed.business_date), data.tz),
    );
  };
  const exportPdf = async () => {
    if (!closed) return;
    const receipt = await dayCloseReceipt(getDb(), String(closed.id));
    if (!receipt) return;
    downloadBlob(
      await receiptPdf(receipt),
      `day-close-${String(closed.business_date)}.pdf`,
    );
  };

  if (closed) {
    return (
      <Box mx="auto" maw={896} p="md" w="100%">
        <Stack gap="sm">
          <Title order={1} fz="h2">
            {t('office.dayclose.title')}
          </Title>
          <Paper withBorder p="lg">
            <Text fw={600} fz="lg" data-testid="day-closed">
              {t('office.dayclose.closed')}
            </Text>
            <SimpleGrid
              component="dl"
              cols={{ base: 2, sm: 3 }}
              spacing="sm"
              mt="sm"
              m={0}
            >
              <Metric
                label={t('office.dayclose.expected')}
                value={<MoneyText paisa={Number(closed.expected_cash)} />}
              />
              <Metric
                label={t('office.dayclose.counted')}
                value={<MoneyText paisa={Number(closed.counted_cash)} />}
              />
              <Metric
                label={t('office.dayclose.difference')}
                value={
                  <Text
                    component="span"
                    c={
                      Number(closed.difference) === 0
                        ? 'teal'
                        : Number(closed.difference) < 0
                          ? 'danger'
                          : 'yellow'
                    }
                  >
                    {Number(closed.difference) === 0
                      ? t('office.dayclose.correct')
                      : `${Number(closed.difference) < 0 ? t('office.dayclose.short') : t('office.dayclose.over')} ${Number(closed.difference) / 100}`}
                  </Text>
                }
              />
            </SimpleGrid>
          </Paper>
          <Group gap="sm">
            <Button
              type="button"
              onClick={() =>
                void queueDayClosePrint(getDb(), String(closed.id)).then(() =>
                  toast.push(t('office.dayclose.print_queued')),
                )
              }
            >
              {t('office.dayclose.print_z')}
            </Button>
            {can('export.data') ? (
              <>
                <Button
                  type="button"
                  variant="default"
                  onClick={() => void exportCsv()}
                >
                  {t('ui.export_csv')}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  onClick={() => void exportPdf()}
                >
                  {t('ui.export_pdf')}
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="default"
              onClick={() => {
                resetForm();
                setClosed(null);
              }}
            >
              {t('office.dayclose.new_close')}
            </Button>
            <Button
              type="button"
              variant="default"
              onClick={() => void navigate({ to: '/' })}
            >
              {t('common.go_home')}
            </Button>
          </Group>
        </Stack>
      </Box>
    );
  }
  return (
    <Box mx="auto" maw={896} p="md" w="100%">
      <Stack gap="sm">
        <PageHeader
          icon={<ClockIcon />}
          title={t('office.dayclose.title')}
          subtitle={`${data.deviceName} · ${t('office.dayclose.period')} ${
            data.firstClose
              ? t('office.dayclose.since_start')
              : period(data.periodStart)
          } → ${period(data.periodEnd)}`}
        />

        <Paper withBorder p="sm">
          <Stack gap="sm">
            <Group justify="space-between" gap="sm" wrap="wrap">
              <Title order={2} fz="md">
                {t('office.dayclose.count_cash')}
              </Title>
              <Group gap="xs">
                <Button
                  type="button"
                  size="compact-sm"
                  variant={mode === 'notes' ? 'light' : 'default'}
                  aria-pressed={mode === 'notes'}
                  onClick={() => setMode('notes')}
                >
                  {t('office.dayclose.notes_mode')}
                </Button>
                <Button
                  type="button"
                  size="compact-sm"
                  variant={mode === 'total' ? 'light' : 'default'}
                  aria-pressed={mode === 'total'}
                  onClick={() => setMode('total')}
                >
                  {t('office.dayclose.total_mode')}
                </Button>
              </Group>
            </Group>

            {mode === 'notes' ? (
              <>
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  {[
                    [
                      5000,
                      ...(show75 ? [COMMEMORATIVE] : []),
                      1000,
                      500,
                      100,
                      50,
                    ],
                    [20, 10, 5, 2, 1],
                  ].map((values) => (
                    <Paper
                      key={values.join('-')}
                      withBorder
                      p="sm"
                      component="section"
                      aria-label={`${t('office.dayclose.count_cash')} ${values[0]}–${values.at(-1)}`}
                    >
                      <Box
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '3.5rem 5rem minmax(0,1fr)',
                          gap: 8,
                          fontSize: 'var(--mantine-font-size-sm)',
                          color: 'var(--mantine-color-dimmed)',
                        }}
                      >
                        <span>{t('office.dayclose.column_note')}</span>
                        <span style={{ textAlign: 'center' }}>
                          {t('office.dayclose.column_count')}
                        </span>
                        <span style={{ textAlign: 'end' }}>
                          {t('office.dayclose.column_amount')}
                        </span>
                      </Box>
                      <Box
                        component="ul"
                        mt="xs"
                        style={{ listStyle: 'none', margin: 0, padding: 0 }}
                      >
                        {values.map((value) => (
                          <Box
                            component="li"
                            key={value}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '3.5rem 5rem minmax(0,1fr)',
                              alignItems: 'center',
                              gap: 8,
                              fontSize: 'var(--mantine-font-size-sm)',
                              marginTop: 8,
                            }}
                          >
                            <Text size="sm" ta="end">
                              {value}
                            </Text>
                            <NumberInput
                              aria-label={String(value)}
                              min={0}
                              hideControls
                              value={notes[value] ?? ''}
                              onChange={(next) =>
                                setNotes((current) => ({
                                  ...current,
                                  [value]: Math.max(0, Number(next) || 0),
                                }))
                              }
                              styles={{ input: { textAlign: 'end' } }}
                            />
                            <Text size="sm" c="dimmed" ta="end">
                              <MoneyText
                                paisa={value * 100 * (notes[value] ?? 0)}
                              />
                            </Text>
                          </Box>
                        ))}
                      </Box>
                    </Paper>
                  ))}
                </SimpleGrid>
                <Button
                  type="button"
                  variant="transparent"
                  size="compact-sm"
                  px={0}
                  onClick={() => setShow75((show) => !show)}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {show75
                    ? t('office.dayclose.hide_75')
                    : t('office.dayclose.show_75')}
                </Button>
              </>
            ) : (
              <MoneyInput
                label={t('office.dayclose.total_counted')}
                value={totalInput}
                onChange={(value) => {
                  setCountTouched(true);
                  setTotalInput(value);
                }}
              />
            )}
            <Group
              justify="space-between"
              pt="xs"
              style={{
                borderTop: '1px solid var(--mantine-color-default-border)',
              }}
            >
              <Text size="sm">{t('office.dayclose.counted')}</Text>
              <Text fz={24} fw={600}>
                <MoneyText paisa={counted} />
              </Text>
            </Group>
          </Stack>
        </Paper>

        {data.firstClose ? (
          <MoneyInput
            label={t('office.dayclose.opening_float')}
            value={opening}
            onChange={(value) => setOpening(value ?? 0)}
          />
        ) : null}

        {blind ? (
          <Button
            type="button"
            disabled={!countTouched}
            onClick={() => setRevealed(true)}
            style={{ alignSelf: 'flex-start' }}
          >
            {t('office.dayclose.next')}
          </Button>
        ) : (
          <Paper withBorder p="sm">
            <Stack gap={4}>
              <Title order={2} fz="md" mb={4}>
                {t('office.dayclose.check')}
              </Title>
              <Line
                label={t('office.dayclose.opening_cash')}
                value={data.firstClose ? opening : data.openingCash}
              />
              <Line
                label={`+ ${t('office.dayclose.cash_sales')}`}
                value={data.components.cash_sales}
              />
              <Line
                label={`+ ${t('office.dayclose.udhaar_in')}`}
                value={data.components.udhaar_cash_in}
              />
              <Line
                label={`+ ${t('office.dayclose.pay_ins')}`}
                value={data.components.pay_ins}
              />
              <Line
                label={`+ ${t('office.dayclose.supplier_in')}`}
                value={data.components.supplier_cash_in}
              />
              <Line
                label={`- ${t('office.dayclose.cash_refunds')}`}
                value={data.components.cash_refunds}
              />
              <Line
                label={`- ${t('office.dayclose.cash_expenses')}`}
                value={data.components.cash_expenses}
              />
              <Line
                label={`- ${t('office.dayclose.supplier_out')}`}
                value={data.components.supplier_cash_out}
              />
              <Line
                label={`- ${t('office.dayclose.pay_outs')}`}
                value={data.components.pay_outs}
              />
              <Box
                pt="xs"
                style={{
                  borderTop: '1px solid var(--mantine-color-default-border)',
                }}
              >
                <Group justify="space-between" gap="sm">
                  <Text size="sm" fw={600}>
                    {t('office.dayclose.expected')}
                  </Text>
                  <Text size="sm" fw={600}>
                    <MoneyText paisa={result.expected_cash} />
                  </Text>
                </Group>
                <Group justify="space-between" gap="sm">
                  <Text size="sm">{t('office.dayclose.counted')}</Text>
                  <Text size="sm">
                    <MoneyText paisa={counted} />
                  </Text>
                </Group>
                <Group justify="space-between" gap="sm">
                  <Text size="sm" fw={600}>
                    {t('office.dayclose.difference')}
                  </Text>
                  <Text
                    size="sm"
                    fw={600}
                    c={
                      result.difference === 0
                        ? 'teal'
                        : result.difference < 0
                          ? 'danger'
                          : 'yellow'
                    }
                  >
                    {result.difference === 0
                      ? t('office.dayclose.correct')
                      : `${result.difference < 0 ? t('office.dayclose.short') : t('office.dayclose.over')} ${Math.abs(result.difference) / 100}`}
                  </Text>
                </Group>
              </Box>
            </Stack>
          </Paper>
        )}

        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
          <Metric
            label={t('office.dayclose.card')}
            value={<MoneyText paisa={data.components.cardTotal} />}
          />
          <Metric
            label={t('office.dayclose.bank')}
            value={<MoneyText paisa={data.components.bankTotal} />}
          />
          <Metric
            label={t('office.dayclose.udhaar_given')}
            value={<MoneyText paisa={data.components.udhaarGiven} />}
          />
          <Metric
            label={t('office.dayclose.bills')}
            value={String(data.components.bills)}
          />
          <Metric
            label={t('office.dayclose.refunds')}
            value={String(data.components.refunds)}
          />
        </SimpleGrid>

        <TextInput
          label={t('office.dayclose.note')}
          maxLength={200}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
        {noteNeeded ? (
          <Text size="sm" c="danger">
            {t('office.dayclose.note_required')}
          </Text>
        ) : null}
        {data.recentClose ? (
          <Text size="sm" c="yellow.9">
            {t('office.dayclose.recent')}
          </Text>
        ) : null}
        <Button
          type="button"
          size="md"
          fullWidth
          disabled={pending || noteNeeded || blind || readOnly}
          loading={pending}
          onClick={() => void close()}
        >
          {t('office.dayclose.close')}
        </Button>

        <ConfirmDialog
          open={confirmAgain}
          onOpenChange={setConfirmAgain}
          title={t('office.dayclose.close_again_title')}
          body={t('office.dayclose.close_again_body')}
          confirmLabel={t('office.dayclose.close_again')}
          onConfirm={() => void close(true)}
        />
      </Stack>
    </Box>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <Group justify="space-between" gap="sm">
      <Text size="sm">{label}</Text>
      <Text size="sm">
        <MoneyText paisa={value} />
      </Text>
    </Group>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={500}>
        {value}
      </Text>
    </Box>
  );
}
