import { businessDate, computeDayClose, newId } from '@bikri/core';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
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
      <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
        <h1 className="text-h1 font-semibold">{t('office.dayclose.title')}</h1>
        <div className="rounded-card border border-border bg-surface p-4">
          <p className="text-title font-semibold" data-testid="day-closed">
            {t('office.dayclose.closed')}
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-small sm:grid-cols-3">
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
                <span
                  className={
                    Number(closed.difference) === 0
                      ? 'text-success-subtle-ink'
                      : Number(closed.difference) < 0
                        ? 'text-danger'
                        : 'text-warning-subtle-ink'
                  }
                >
                  {Number(closed.difference) === 0
                    ? t('office.dayclose.correct')
                    : `${Number(closed.difference) < 0 ? t('office.dayclose.short') : t('office.dayclose.over')} ${Number(closed.difference) / 100}`}
                </span>
              }
            />
          </dl>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonPrimary}
            onClick={() =>
              void queueDayClosePrint(getDb(), String(closed.id)).then(() =>
                toast.push(t('office.dayclose.print_queued')),
              )
            }
          >
            {t('office.dayclose.print_z')}
          </button>
          {can('export.data') ? (
            <>
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => void exportCsv()}
              >
                {t('ui.export_csv')}
              </button>
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => void exportPdf()}
              >
                {t('ui.export_pdf')}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => {
              resetForm();
              setClosed(null);
            }}
          >
            {t('office.dayclose.new_close')}
          </button>
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => void navigate({ to: '/' })}
          >
            {t('common.go_home')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
      <PageHeader
        icon={<ClockIcon />}
        title={t('office.dayclose.title')}
        subtitle={`${data.deviceName} · ${t('office.dayclose.period')} ${
          data.firstClose
            ? t('office.dayclose.since_start')
            : period(data.periodStart)
        } → ${period(data.periodEnd)}`}
      />

      <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-title font-semibold">
            {t('office.dayclose.count_cash')}
          </h2>
          <div className="ms-auto flex gap-1">
            <button
              type="button"
              aria-pressed={mode === 'notes'}
              className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
              onClick={() => setMode('notes')}
            >
              {t('office.dayclose.notes_mode')}
            </button>
            <button
              type="button"
              aria-pressed={mode === 'total'}
              className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
              onClick={() => setMode('total')}
            >
              {t('office.dayclose.total_mode')}
            </button>
          </div>
        </div>
        {mode === 'notes' ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                [5000, ...(show75 ? [COMMEMORATIVE] : []), 1000, 500, 100, 50],
                [20, 10, 5, 2, 1],
              ].map((values) => (
                <section
                  key={values.join('-')}
                  aria-label={`${t('office.dayclose.count_cash')} ${values[0]}–${values.at(-1)}`}
                  className="rounded-control border border-border p-3"
                >
                  <div className="grid grid-cols-[3.5rem_5rem_minmax(0,1fr)] gap-2 text-small text-text-muted">
                    <span>{t('office.dayclose.column_note')}</span>
                    <span className="text-center">
                      {t('office.dayclose.column_count')}
                    </span>
                    <span className="text-end">
                      {t('office.dayclose.column_amount')}
                    </span>
                  </div>
                  <ul className="mt-2 flex flex-col gap-2">
                    {values.map((value) => (
                      <li key={value}>
                        <label className="grid grid-cols-[3.5rem_5rem_minmax(0,1fr)] items-center gap-2 text-small">
                          <span className="text-end">{value}</span>
                          <input
                            type="number"
                            min={0}
                            inputMode="numeric"
                            className="h-11 w-20 min-w-0 rounded-control border border-border-strong bg-surface px-2 text-end"
                            value={notes[value] ?? ''}
                            onChange={(e) =>
                              setNotes((current) => ({
                                ...current,
                                [value]: Math.max(
                                  0,
                                  Number(e.target.value) || 0,
                                ),
                              }))
                            }
                          />
                          <span className="text-end text-text-muted">
                            <MoneyText
                              paisa={value * 100 * (notes[value] ?? 0)}
                            />
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <button
              type="button"
              className="min-h-11 self-start text-small underline"
              onClick={() => setShow75((show) => !show)}
            >
              {show75
                ? t('office.dayclose.hide_75')
                : t('office.dayclose.show_75')}
            </button>
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
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-2">
          <span className="text-small">{t('office.dayclose.counted')}</span>
          <span className="text-figure font-semibold">
            <MoneyText paisa={counted} />
          </span>
        </div>
      </section>

      {data.firstClose ? (
        <MoneyInput
          label={t('office.dayclose.opening_float')}
          value={opening}
          onChange={(value) => setOpening(value ?? 0)}
        />
      ) : null}

      {blind ? (
        <button
          type="button"
          className={buttonPrimary}
          disabled={!countTouched}
          onClick={() => setRevealed(true)}
        >
          {t('office.dayclose.next')}
        </button>
      ) : (
        <section className="flex flex-col gap-1 rounded-card border border-border bg-surface p-3 text-small">
          <h2 className="text-title font-semibold">
            {t('office.dayclose.check')}
          </h2>
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
          <div className="flex justify-between border-t border-border pt-1 font-semibold">
            <span>{t('office.dayclose.expected')}</span>
            <MoneyText paisa={result.expected_cash} />
          </div>
          <div className="flex justify-between">
            <span>{t('office.dayclose.counted')}</span>
            <MoneyText paisa={counted} />
          </div>
          <div className="flex justify-between font-semibold">
            <span>{t('office.dayclose.difference')}</span>
            <span
              className={
                result.difference === 0
                  ? 'text-success-subtle-ink'
                  : result.difference < 0
                    ? 'text-danger'
                    : 'text-warning-subtle-ink'
              }
            >
              {result.difference === 0
                ? t('office.dayclose.correct')
                : `${result.difference < 0 ? t('office.dayclose.short') : t('office.dayclose.over')} ${Math.abs(result.difference) / 100}`}
            </span>
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 gap-2 text-small sm:grid-cols-4">
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
      </section>

      <label className="flex flex-col gap-1 text-small">
        {t('office.dayclose.note')}
        <input
          className="h-11 rounded-control border border-border-strong bg-surface px-3"
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {noteNeeded ? (
        <p className="text-small text-danger">
          {t('office.dayclose.note_required')}
        </p>
      ) : null}
      {data.recentClose ? (
        <p className="text-small text-warning-subtle-ink">
          {t('office.dayclose.recent')}
        </p>
      ) : null}
      <button
        type="button"
        className={`${buttonPrimary} min-h-14`}
        disabled={pending || noteNeeded || blind || readOnly}
        onClick={() => void close()}
      >
        {t('office.dayclose.close')}
      </button>

      <ConfirmDialog
        open={confirmAgain}
        onOpenChange={setConfirmAgain}
        title={t('office.dayclose.close_again_title')}
        body={t('office.dayclose.close_again_body')}
        confirmLabel={t('office.dayclose.close_again')}
        onConfirm={() => void close(true)}
      />
    </div>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <MoneyText paisa={value} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-text-muted">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
