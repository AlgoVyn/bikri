import type { PrintJob } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyText } from '../components/MoneyText.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { retryPrintJob } from '../data/printJobs.ts';
import {
  latestSaleJob,
  queueSalePrint,
  receiptShareText,
  waLink,
} from '../data/receipt.ts';
import { formatShopMoney } from '../lib/money';
import { ignoresHotkey } from '../shell/hotkeys.ts';
import type { Done } from './PayDialog.tsx';

/** Keys closer together than this are a barcode scanner, not a person (05-sell scanner rule). */
const SCAN_GAP_MS = 50;
const AUTO_CLOSE_MS = 8000;

/**
 * Turns the window's keys into scans and single-key shortcuts. A shortcut letter waits one
 * scanner gap so that the first character of a scan never triggers it.
 */
function useScanKeys(
  onScan: (code: string) => void,
  shortcuts: Record<string, () => void>,
) {
  const ref = useRef({ onScan, shortcuts });
  ref.current = { onScan, shortcuts };
  useEffect(() => {
    let buffer = '';
    let last = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      if (ignoresHotkey(e.target)) return;
      const now = performance.now();
      const fast = now - last < SCAN_GAP_MS;
      if (e.key === 'Enter') {
        if (fast && buffer.length >= 3) {
          e.preventDefault();
          e.stopPropagation();
          clearTimeout(pending);
          const code = buffer;
          buffer = '';
          ref.current.onScan(code);
        }
        buffer = '';
        return;
      }
      if (e.key.length !== 1) return;
      e.preventDefault();
      buffer = fast ? buffer + e.key : e.key;
      last = now;
      clearTimeout(pending);
      const action = ref.current.shortcuts[e.key.toLowerCase()];
      if (action && buffer.length === 1)
        pending = setTimeout(() => {
          if (buffer.length === 1) action();
        }, SCAN_GAP_MS + 10);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(pending);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
}

function PrintStatus({
  job,
  hasPrinter,
}: {
  job: PrintJob | undefined;
  hasPrinter: boolean;
}) {
  const { t } = useTranslation();
  if (!job) return null;
  const text =
    job.status === 'done'
      ? t('done.printed')
      : job.status === 'failed'
        ? t('done.print_failed')
        : hasPrinter
          ? t('done.printing')
          : t('done.print_waiting');
  return (
    <p
      role="status"
      data-testid="print-status"
      className={`flex items-center gap-2 text-small ${job.status === 'failed' ? 'text-danger' : 'text-text-muted'}`}
    >
      {text}
      {job.status === 'failed' ? (
        <button
          type="button"
          className="underline"
          onClick={() => void retryPrintJob(getDb(), job.id)}
        >
          {t('done.retry')}
        </button>
      ) : null}
    </p>
  );
}

/** Step 2 of the pay modal (screens/07). */
export function SaleComplete({
  done,
  onNewSale,
  onScan,
  onOpenBill,
}: {
  done: Done;
  onNewSale: () => void;
  onScan: (code: string) => void;
  onOpenBill: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { sale } = done;
  const saleId = String(sale.id);
  const invoice = String(sale.invoice_no);
  const newSale = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<'share' | 'pdf' | null>(null);
  useEffect(() => newSale.current?.focus(), []);
  const job = useLiveQuery(() => latestSaleJob(getDb(), saleId), [saleId]);
  const settings = useLiveQuery(async () => {
    const kv = getDb().kv;
    return {
      printer: (await kv.get('printer'))?.value != null,
      autoClose:
        ((await kv.get('display'))?.value as { auto_close?: boolean } | null)
          ?.auto_close === true,
    };
  }, []);
  useEffect(() => {
    if (!settings?.autoClose) return;
    const timer = setTimeout(onNewSale, AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [settings?.autoClose, onNewSale]);

  const printAgain = async () => {
    await queueSalePrint(getDb(), saleId, { reprint: true });
  };

  const share = async () => {
    if (busy) return;
    setBusy('share');
    try {
      const { saleReceipt, receiptPng, downloadBlob } = await import(
        '../print/receiptFiles.ts'
      );
      const r = await saleReceipt(getDb(), saleId);
      if (!r) return;
      const png = await receiptPng(r);
      const text = receiptShareText(r.input);
      const link = done.customerPhone ? waLink(done.customerPhone, text) : null;
      const file = new File([png], `${invoice}.png`, { type: 'image/png' });
      if (link) {
        downloadBlob(png, file.name);
        window.open(link, '_blank', 'noopener');
        toast.push(t('done.image_saved'), 'info');
      } else if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text, title: invoice });
      } else {
        downloadBlob(png, file.name);
        toast.push(t('done.image_saved'), 'info');
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        toast.push(t('done.share_failed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pdf = async () => {
    if (busy) return;
    setBusy('pdf');
    try {
      const { saleReceipt, receiptPdf, downloadBlob } = await import(
        '../print/receiptFiles.ts'
      );
      const r = await saleReceipt(getDb(), saleId);
      if (r) downloadBlob(await receiptPdf(r), `${invoice}.pdf`);
    } catch {
      toast.push(t('done.share_failed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  useScanKeys(onScan, {
    n: onNewSale,
    p: () => void printAgain(),
  });

  const change = Number(sale.change_given ?? 0);
  const udhaar = Number(sale.udhaar_amount ?? 0);
  const whatsapp = Boolean(done.customerPhone);
  return (
    <div
      className="mx-auto flex w-full max-w-md flex-col items-center gap-3 py-4 text-center"
      data-testid="sale-complete"
    >
      <span
        aria-hidden="true"
        className="flex size-16 items-center justify-center rounded-full bg-success-subtle text-figure text-success-subtle-ink"
      >
        ✓
      </span>
      <p className="text-title" data-testid="sale-saved">
        {t('pay.saved', { invoice })}
      </p>
      {change > 0 ? (
        <p className="text-figure font-semibold" data-testid="done-change">
          {t('pay.change', { amount: formatShopMoney(change) })}
        </p>
      ) : null}
      {udhaar > 0 ? (
        <p data-testid="done-udhaar">
          {t('pay.udhaar_written', {
            amount: formatShopMoney(udhaar),
            name: done.customerName,
            balance: formatShopMoney(done.balance),
          })}
        </p>
      ) : null}
      <dl className="w-full rounded-card border border-border bg-surface-2/50 p-3 text-start text-small">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-text-muted">
            {t('sell.items', { count: Number(sale.line_count ?? 0) })}
          </dt>
          <dd>
            <MoneyText paisa={Number(sale.total ?? 0)} />
          </dd>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <dt className="text-text-muted">{t('done.paid')}</dt>
          <dd>
            <MoneyText paisa={Number(sale.paid_total ?? 0)} />
          </dd>
        </div>
        {done.customerName ? (
          <div className="mt-1 flex items-center justify-between gap-2">
            <dt className="text-text-muted">{t('done.customer')}</dt>
            <dd className="truncate">{done.customerName}</dd>
          </div>
        ) : null}
      </dl>
      <PrintStatus job={job} hasPrinter={settings?.printer ?? false} />
      <button
        ref={newSale}
        type="button"
        className={`${buttonPrimary} min-h-14 w-full text-title`}
        onClick={onNewSale}
      >
        {t('pay.new_sale')}
      </button>
      <div className="grid w-full grid-cols-2 gap-2">
        <button
          type="button"
          className={`${buttonQuiet} gap-2`}
          onClick={() => void printAgain()}
        >
          {t('done.print_again')}
        </button>
        <button
          type="button"
          className={buttonQuiet}
          aria-busy={busy === 'share'}
          onClick={() => void share()}
        >
          {whatsapp ? t('done.share_whatsapp') : t('done.share')}
        </button>
        <button
          type="button"
          className={buttonQuiet}
          aria-busy={busy === 'pdf'}
          onClick={() => void pdf()}
        >
          {t('done.download_pdf')}
        </button>
        <button type="button" className={buttonQuiet} onClick={onOpenBill}>
          {t('done.open_bill')}
        </button>
      </div>
    </div>
  );
}
