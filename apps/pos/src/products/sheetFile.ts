/** Reads a CSV or XLSX file into a grid of strings; parsing runs in a worker when possible. */

const WORKER_TIMEOUT_MS = 30_000;
let nextId = 1;

/** The file itself is unreadable; retrying the same bytes is useless. */
class SheetParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetParseError';
  }
}

function readInWorker(file: File): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./sheetFileWorker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (error) {
      reject(error);
      return;
    }
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('spreadsheet worker timed out'));
    }, WORKER_TIMEOUT_MS);
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (
      event: MessageEvent<{ id: number; grid?: string[][]; error?: string }>,
    ) => {
      if (event.data.id !== id) return;
      finish();
      if (event.data.grid !== undefined) resolve(event.data.grid);
      else
        reject(
          new SheetParseError(event.data.error ?? 'spreadsheet parse failed'),
        );
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'spreadsheet worker failed'));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error('spreadsheet worker message failed'));
    };
    worker.postMessage({ id, file });
  });
}

export async function readSheetFile(file: File): Promise<string[][]> {
  // Parsing happens only in the module worker: a main-thread fallback duplicated both
  // parser libraries in the offline precache (~23 KB gz) and blocked the counter on a
  // 5,000-row file. Every browser that can run this PWA supports module workers.
  if (typeof Worker === 'undefined')
    throw new SheetParseError(
      'This browser cannot read spreadsheets. Update it and try again.',
    );
  return readInWorker(file);
}
