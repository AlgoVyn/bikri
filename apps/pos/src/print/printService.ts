/**
 * Print service (06 §9): takes queued print jobs oldest first, builds the receipt, sends it with
 * the device's transport and records done / failed. A failed print never touches the sale.
 */
import type { BikriDb, PrintJob } from '@bikri/db';
import {
  type Block,
  buildTestPrint,
  encodeEscPos,
  type RasterRenderer,
  type RasterSource,
  renderReceiptHtml,
} from '@bikri/printer';
import { deviceInfo } from '../data/localTenant.ts';
import {
  logDrawerOpen,
  type PrinterKv,
  receiptPaper,
} from '../data/receipt.ts';
import { jobReceipt } from './receiptFiles.ts';
import { printHtmlViaSystem, type SystemPrintResult } from './systemPrint.ts';
import {
  findSerial,
  findUsb,
  PrintError,
  type PrintErrorCode,
  type SerialLike,
  sendSerial,
  sendUsb,
  type UsbLike,
  withTimeout,
} from './transports.ts';

export type PrintDeps = {
  usb: UsbLike | null;
  serial: SerialLike | null;
  renderer?: RasterRenderer;
  system?: (html: string, widthMm: 58 | 80) => Promise<SystemPrintResult>;
  timeoutMs?: number;
  /** Logo as a data URL for system printing. */
  logoUrl?: (logo: RasterSource) => string | null;
};

export async function readPrinter(db: BikriDb): Promise<PrinterKv | null> {
  return ((await db.kv.get('printer'))?.value ?? null) as PrinterKv | null;
}

async function readLogo(db: BikriDb): Promise<RasterSource | null> {
  return ((await db.kv.get('logo_bitmap'))?.value ??
    null) as RasterSource | null;
}

async function receiptLanguage(db: BikriDb): Promise<'ur' | 'en'> {
  const shop = await db.shop.get('shop');
  return shop?.receipt_language === 'ur' ? 'ur' : 'en';
}

/** ESC/POS bytes for blocks on this printer (06 §3). */
export function encodeFor(
  blocks: Block[],
  printer: PrinterKv,
  options: {
    logo: RasterSource | null;
    renderer?: RasterRenderer;
    language?: 'ur' | 'en';
  },
): Uint8Array {
  const paper = receiptPaper(printer);
  return encodeEscPos(blocks, {
    charsPerLine: paper.charsPerLine,
    dots: paper.dots,
    itemLayout: paper.itemLayout,
    cut: printer.cut ?? 'partial',
    drawerPin: printer.drawer_pin ?? 2,
    logo: printer.print_logo === false ? null : options.logo,
    renderer: options.renderer,
    language: options.language ?? 'en',
  });
}

/** Sends blocks to the printer: bytes over USB / Serial, or HTML through the system dialog. */
export async function printBlocks(
  db: BikriDb,
  blocks: Block[],
  printer: PrinterKv | null,
  deps: PrintDeps,
  copies = 1,
  languageOverride?: 'en' | 'ur',
): Promise<void> {
  if (!printer?.transport) throw new PrintError('NO_PRINTER');
  const logo = await readLogo(db);
  const paper = receiptPaper(printer);
  if (printer.transport === 'system') {
    const html = renderReceiptHtml(blocks, {
      widthMm: paper.paperMm,
      charsPerLine: paper.charsPerLine,
      itemLayout: paper.itemLayout,
      logoUrl:
        logo && printer.print_logo !== false
          ? (deps.logoUrl?.(logo) ?? null)
          : null,
    });
    const system = deps.system ?? printHtmlViaSystem;
    for (let i = 0; i < copies; i += 1) {
      const result = await system(html, paper.paperMm);
      if (!result.ok)
        throw new PrintError(
          result.code === 'TIMEOUT' ? 'TIMEOUT' : 'UNSUPPORTED',
        );
    }
    return;
  }
  const one = encodeFor(blocks, printer, {
    logo,
    renderer: deps.renderer,
    language: languageOverride ?? (await receiptLanguage(db)),
  });
  const bytes = new Uint8Array(one.length * copies);
  for (let i = 0; i < copies; i += 1) bytes.set(one, i * one.length);
  const timeout = deps.timeoutMs;
  if (printer.transport === 'usb') {
    const device = await findUsb(deps.usb, printer.usb);
    if (!device)
      throw new PrintError(deps.usb ? 'DISCONNECTED' : 'UNSUPPORTED');
    await withTimeout(sendUsb(device, bytes), timeout);
    return;
  }
  const port = await findSerial(deps.serial, printer.serial);
  if (!port) throw new PrintError(deps.serial ? 'DISCONNECTED' : 'UNSUPPORTED');
  await withTimeout(
    sendSerial(port, bytes, {
      baudRate: printer.serial?.baudRate ?? 9600,
      flowControl: printer.serial?.flowControl ?? 'none',
    }),
    timeout,
  );
}

export function errorCode(err: unknown): PrintErrorCode {
  return err instanceof PrintError ? err.code : 'FAILED';
}

/** Runs one job: printing → done, or failed with a code. */
export async function runJob(
  db: BikriDb,
  job: PrintJob,
  deps: PrintDeps,
): Promise<PrintJob> {
  await db.print_jobs.update(job.id, {
    status: 'printing',
    error: undefined,
    started_at: Date.now(),
  });
  try {
    const printer = await readPrinter(db);
    if (!printer?.transport) throw new PrintError('NO_PRINTER');
    const r = await jobReceipt(db, job);
    if (!r) throw new PrintError('FAILED', 'nothing to print');
    await printBlocks(
      db,
      r.blocks,
      printer,
      deps,
      Math.min(3, Math.max(1, printer.copies ?? 1)),
    );
    await db.print_jobs.update(job.id, { status: 'done' });
    return { ...job, status: 'done', error: undefined };
  } catch (err) {
    const error = errorCode(err);
    await db.print_jobs.update(job.id, { status: 'failed', error });
    return { ...job, status: 'failed', error };
  }
}

const running = new WeakMap<BikriDb, Promise<void>>();

/**
 * Prints every queued job, oldest first, one at a time per database. Without a set-up printer
 * jobs stay queued (the receipt is printed once a printer exists, or reprinted later).
 */
export function processQueue(
  db: BikriDb,
  deps: PrintDeps,
  onResult?: (job: PrintJob) => void,
): Promise<void> {
  const current = running.get(db);
  if (current) return current;
  const run = (async () => {
    try {
      const seen = new Set<string>();
      for (;;) {
        if (!(await readPrinter(db))?.transport) return;
        const next = (
          await db.print_jobs
            .where('status')
            .equals('queued')
            .sortBy('created_at')
        ).find((j) => !seen.has(j.id));
        if (!next) return;
        seen.add(next.id);
        // Not `onResult?.(await runJob(…))`: optional calls skip evaluating their arguments.
        const result = await runJob(db, next, deps);
        onResult?.(result);
      }
    } finally {
      running.delete(db);
    }
  })();
  running.set(db, run);
  return run;
}

/** Test page (06 §4.3) at the draft settings, before they are saved. */
export async function printTestPage(
  db: BikriDb,
  printer: PrinterKv,
  deps: PrintDeps,
): Promise<void> {
  const paper = receiptPaper(printer);
  await printBlocks(
    db,
    buildTestPrint({
      charsPerLine: paper.charsPerLine,
      printLogo: printer.print_logo !== false,
      drawer: printer.drawer !== false,
    }),
    printer,
    deps,
    1,
    'en',
  );
}

/** F9 / Settings "Open drawer" (06 §7): drawer kick only; system printing cannot do it. */
export async function kickDrawer(
  db: BikriDb,
  printer: PrinterKv | null,
  deps: PrintDeps,
): Promise<void> {
  if (printer?.transport === 'system') throw new PrintError('UNSUPPORTED');
  await printBlocks(db, [{ t: 'drawer' }], printer, deps);
}

/** Kick the drawer and write the `drawer_open` audit row (F9, Settings → Open drawer). */
export async function openDrawer(
  db: BikriDb,
  deps: PrintDeps,
  staffId: string | null,
): Promise<void> {
  await kickDrawer(db, await readPrinter(db), deps);
  const device = await deviceInfo(db);
  await logDrawerOpen(db, { device_id: device?.id ?? '', staff_id: staffId });
}
