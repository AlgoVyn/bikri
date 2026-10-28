import type { PrintJob } from '@bikri/db';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { setKv } from '../data/kv.ts';
import { retryPrintJob } from '../data/printJobs.ts';
import type { PrinterKv } from '../data/receipt.ts';
import { browserPrintDeps } from '../print/printDeps.ts';
import { errorCode, openDrawer, printTestPage } from '../print/printService.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { PrinterWizard } from './PrinterWizard.tsx';

const selectClass =
  'h-11 rounded-control border border-border-strong bg-surface px-2';

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
    <label className="flex min-h-11 items-center justify-between gap-3">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        className="size-5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
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
  const [wizard, setWizard] = useState(false);
  // Cashiers' settings.device covers display and language only (05 §6).
  const editable = can('settings.device') && role !== 'cashier';
  const deps = browserPrintDeps();

  const update = (p: Partial<PrinterKv>) =>
    void setKv(getDb(), 'printer', { ...printer, ...p });

  const run = async (what: 'test' | 'drawer') => {
    try {
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
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/settings" className={buttonQuiet}>
          {t('common.back')}
        </Link>
        <h1 className="text-h1 font-semibold">{t('printer.title')}</h1>
      </div>
      <section
        className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4"
        aria-labelledby="printer-status"
      >
        <h2 id="printer-status" className="font-semibold">
          {t('printer.status')}
        </h2>
        <p data-testid="printer-summary">
          {printer?.transport
            ? t('printer.summary', {
                where,
                mm: printer.paper_mm ?? 80,
                chars:
                  printer.chars_per_line ?? (printer.paper_mm === 58 ? 32 : 48),
              })
            : t('printer.none')}
        </p>
        {lastFailed ? (
          <p className="text-small text-danger">
            {t('printer.last_error', {
              reason: t(`print.err_${lastFailed.job.error ?? 'FAILED'}`),
            })}
          </p>
        ) : null}
        <p className="text-small text-text-muted">{t('printer.never_loses')}</p>
        {wizard ? null : editable ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => setWizard(true)}
            >
              {t('printer.setup')}
            </button>
            {printer?.transport ? (
              <>
                <button
                  type="button"
                  className={buttonQuiet}
                  onClick={() => void run('test')}
                >
                  {t('printer.test_print')}
                </button>
                {can('drawer.open') && printer.transport !== 'system' ? (
                  <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() => void run('drawer')}
                  >
                    {t('printer.open_drawer')}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : (
          <p className="text-small text-text-muted">{t('printer.ask_owner')}</p>
        )}
        <details className="text-small">
          <summary className="cursor-pointer text-primary">
            {t('printer.which')}
          </summary>
          <p className="mt-1">{t('printer.which_body')}</p>
        </details>
      </section>

      {wizard ? (
        <PrinterWizard current={printer} onDone={() => setWizard(false)} />
      ) : null}

      {printer?.transport && editable && !wizard ? (
        <section
          className="flex flex-col gap-1 rounded-card border border-border bg-surface p-4"
          aria-labelledby="printer-options"
        >
          <h2 id="printer-options" className="font-semibold">
            {t('printer.options')}
          </h2>
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
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span>{t('printer.copies')}</span>
            <select
              className={selectClass}
              value={printer.copies ?? 1}
              onChange={(e) => update({ copies: Number(e.target.value) })}
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span>{t('printer.drawer_pin')}</span>
            <select
              className={selectClass}
              value={printer.drawer_pin ?? 2}
              onChange={(e) =>
                update({ drawer_pin: Number(e.target.value) as 2 | 5 })
              }
            >
              <option value={2}>2</option>
              <option value={5}>5</option>
            </select>
          </label>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span>{t('printer.cut')}</span>
            <select
              className={selectClass}
              value={printer.cut ?? 'partial'}
              onChange={(e) =>
                update({ cut: e.target.value as PrinterKv['cut'] })
              }
            >
              {(['partial', 'full', 'none'] as const).map((c) => (
                <option key={c} value={c}>
                  {t(`printer.cut_${c}`)}
                </option>
              ))}
            </select>
          </label>
        </section>
      ) : null}

      <section className="flex flex-col gap-2" aria-labelledby="recent-prints">
        <h2 id="recent-prints" className="font-semibold">
          {t('printer.recent')}
        </h2>
        {jobs && jobs.length === 0 ? (
          <p className="text-text-muted">{t('printer.recent_empty')}</p>
        ) : null}
        <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
          {jobs?.map(({ job, invoice }) => (
            <li
              key={job.id}
              data-testid="print-job"
              className="flex flex-wrap items-center gap-2 p-3"
            >
              <span className="flex-1">
                {invoice
                  ? t('printer.job_bill', { invoice })
                  : t(`printer.kind_${job.kind}`)}
                {job.reprint ? ` · ${t('printer.reprint')}` : ''}
                <span className="block text-small text-text-muted">
                  {timeOf(job.created_at, i18n.language)}
                </span>
              </span>
              <span
                className={
                  job.status === 'failed' ? 'text-danger' : 'text-text-muted'
                }
              >
                {job.status === 'failed'
                  ? t(`print.err_${job.error ?? 'FAILED'}`)
                  : t(`printer.status_${job.status}`)}
              </span>
              {job.status === 'failed' ? (
                <button
                  type="button"
                  className={buttonQuiet}
                  onClick={() => void retryPrintJob(getDb(), job.id)}
                >
                  {t('done.retry')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
