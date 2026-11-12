/**
 * Print service (06 §9): takes queued print jobs oldest first, builds the receipt, sends it with
 * the device's transport and records done / failed. A failed print never touches the sale.
 */

import { newId } from '@bikri/core';
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
  resolveReceiptLanguage,
} from '../data/receipt.ts';
import { ReadOnlyError } from '../data/write.ts';
import { isReadOnly } from '../sync/status.ts';
import {
  type AgentClient,
  type AgentJob,
  type AgentPrintRequest,
  AgentRequestError,
  httpAgentClient,
} from './agent.ts';
import { prepareRasterFonts } from './canvasRaster.ts';
import { jobReceipt } from './receiptFiles.ts';
import { renderReceiptCanvas } from './receiptImage.ts';
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
  /** Local print agent (docs/14-print-agent.md). */
  agent?: AgentClient;
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
  return resolveReceiptLanguage(
    typeof shop?.receipt_language === 'string'
      ? shop.receipt_language
      : undefined,
  );
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
    leftMarginDots: paper.leftMarginDots,
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
  jobId?: string,
): Promise<void> {
  if (!printer?.transport) throw new PrintError('NO_PRINTER');
  const logo = await readLogo(db);
  const paper = receiptPaper(printer);
  if (printer.transport === 'agent' && printer.agent?.mode === 'driver') {
    const canvas = await renderReceiptCanvas(blocks, {
      dots: paper.dots,
      paperDots: paper.paperDots,
      charsPerLine: paper.charsPerLine,
      itemLayout: paper.itemLayout,
      logo: printer.print_logo === false ? null : logo,
      padding: 0,
    });
    const png = canvas.toDataURL('image/png').split(',')[1];
    if (!png) throw new PrintError('FAILED', 'receipt image is empty');
    await sendAgentJob(
      printer,
      {
        mode: 'driver',
        encoding: 'png',
        data: png,
        copies: Math.min(3, Math.max(1, copies)),
        paperMm: paper.paperMm,
        widthDots: canvas.width,
      },
      deps,
      jobId,
    );
    return;
  }
  if (printer.transport === 'agent' && printer.agent?.mode !== 'raw')
    throw new PrintError('NO_PRINTER');
  if (printer.transport === 'system') {
    const html = renderReceiptHtml(blocks, {
      widthMm: paper.printMm,
      charsPerLine: paper.charsPerLine,
      itemLayout: paper.itemLayout,
      logoUrl:
        logo && printer.print_logo !== false
          ? (deps.logoUrl?.(logo) ?? null)
          : null,
    });
    const system = deps.system ?? printHtmlViaSystem;
    for (let i = 0; i < copies; i += 1) {
      const result = await system(html, paper.printMm);
      if (!result.ok)
        throw new PrintError(
          result.code === 'TIMEOUT' ? 'TIMEOUT' : 'UNSUPPORTED',
        );
    }
    return;
  }
  await prepareRasterFonts();
  const language = languageOverride ?? (await receiptLanguage(db));
  // A drawer kick belongs to the sale/refund action, not to every copy of its
  // receipt. Encode the body without drawer blocks and append one kick after all
  // copies (the command is harmless if no drawer is attached).
  const drawer = blocks.some((block) => block.t === 'drawer');
  const body = blocks.filter((block) => block.t !== 'drawer');
  const one = encodeFor(body, printer, {
    logo,
    renderer: deps.renderer,
    language,
  });
  const parts: Uint8Array[] = [];
  for (let i = 0; i < copies; i += 1) parts.push(one);
  if (drawer)
    parts.push(
      encodeFor([{ t: 'drawer' }], printer, {
        logo: null,
        renderer: deps.renderer,
        language,
      }),
    );
  const bytes = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  if (printer.transport === 'agent') {
    await sendAgentJob(
      printer,
      {
        mode: 'raw',
        encoding: 'escpos',
        data: toBase64(bytes),
        copies: 1,
        paperMm: paper.paperMm,
        widthDots: paper.dots,
      },
      deps,
      jobId,
    );
    return;
  }
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

type AgentPayload = Omit<AgentPrintRequest, 'jobId' | 'printer'>;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Browser-safe base64 for potentially large ESC/POS buffers. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function sendAgentJob(
  printer: PrinterKv,
  payload: AgentPayload,
  deps: PrintDeps,
  jobId?: string,
): Promise<void> {
  const config = printer.agent;
  if (!config) throw new PrintError('NO_PRINTER');
  const client = deps.agent ?? httpAgentClient;
  const request: AgentPrintRequest = {
    ...payload,
    jobId: jobId ?? newId(),
    printer: config.printerName,
  };
  let job: AgentJob;
  try {
    job = await client.print(config.url, config.token, request);
  } catch (err) {
    throw mapAgentError(err);
  }
  const deadline = Date.now() + (deps.timeoutMs ?? 30_000);
  while (
    job.status !== 'done' &&
    job.status !== 'failed' &&
    job.status !== 'canceled'
  ) {
    if (Date.now() >= deadline) throw new PrintError('TIMEOUT');
    await sleep(400);
    try {
      job = await client.job(config.url, config.token, job.jobId);
    } catch (err) {
      throw mapAgentError(err);
    }
  }
  if (job.status === 'failed')
    throw new PrintError(agentErrorCode(job.error), job.detail);
  if (job.status === 'canceled')
    throw new PrintError('FAILED', 'print job canceled');
}

function agentErrorCode(code: string | undefined): PrintErrorCode {
  switch (code) {
    case 'PAPER_OUT':
      return 'PAPER_OUT';
    case 'PRINTER_OFFLINE':
      return 'DISCONNECTED';
    case 'RAW_UNSUPPORTED':
      return 'UNSUPPORTED';
    case 'UNKNOWN_PRINTER':
      return 'NO_PRINTER';
    case 'UNAUTHORIZED':
    case 'PAIRING_CODE':
      return 'AGENT_AUTH';
    case 'TIMEOUT':
      return 'TIMEOUT';
    default:
      return 'FAILED';
  }
}

function mapAgentError(err: unknown): PrintError {
  if (err instanceof PrintError) return err;
  if (err instanceof AgentRequestError) {
    if (err.code === 'UNAVAILABLE') return new PrintError('DISCONNECTED');
    if (err.status === 401) return new PrintError('AGENT_AUTH');
    return new PrintError(agentErrorCode(err.code));
  }
  return new PrintError('DISCONNECTED', (err as Error)?.message);
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
      undefined,
      job.id,
    );
    await db.print_jobs.update(job.id, { status: 'done' });
    return { ...job, status: 'done', error: undefined };
  } catch (err) {
    const error = errorCode(err);
    await db.print_jobs.update(job.id, { status: 'failed', error });
    return { ...job, status: 'failed', error };
  }
}

/** Atomically claims the oldest queued job. IndexedDB serialises this across tabs. */
async function claimNextJob(db: BikriDb): Promise<PrintJob | null> {
  return db.transaction('rw', db.print_jobs, async () => {
    const next = (
      await db.print_jobs.where('status').equals('queued').sortBy('created_at')
    )[0];
    if (!next) return null;
    const started_at = Date.now();
    await db.print_jobs.update(next.id, {
      status: 'printing',
      error: undefined,
      started_at,
    });
    return { ...next, status: 'printing', error: undefined, started_at };
  });
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
      for (;;) {
        if (!(await readPrinter(db))?.transport) return;
        const next = await claimNextJob(db);
        if (!next) return;
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
  options: { drawer?: boolean } = {},
): Promise<void> {
  const paper = receiptPaper(printer);
  const drawer = options.drawer ?? printer.drawer !== false;
  await printBlocks(
    db,
    buildTestPrint({
      charsPerLine: paper.charsPerLine,
      printLogo: printer.print_logo !== false,
      drawer,
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
  if (printer?.transport === 'agent' && printer.agent?.mode !== 'raw')
    throw new PrintError('UNSUPPORTED');
  await printBlocks(db, [{ t: 'drawer' }], printer, deps);
}

/** Kick the drawer and write the `drawer_open` audit row (F9, Settings → Open drawer). */
export async function openDrawer(
  db: BikriDb,
  deps: PrintDeps,
  staffId: string | null,
): Promise<void> {
  if (
    (await isReadOnly(db)) ||
    (await db.kv.get('device_kind'))?.value === 'support'
  )
    throw new ReadOnlyError();
  await kickDrawer(db, await readPrinter(db), deps);
  const device = await deviceInfo(db);
  await logDrawerOpen(db, { device_id: device?.id ?? '', staff_id: staffId });
}
