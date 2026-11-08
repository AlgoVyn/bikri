/** Reads a CSV or XLSX file into a grid of strings; parsing runs in a worker when possible. */

const WORKER_TIMEOUT_MS = 30_000;
let nextId = 1;

function readMainThread(file: File): Promise<string[][]> {
  return (async () => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsx')) {
      const { readSheet } = await import('read-excel-file/browser');
      const data = await readSheet(file);
      return data.map((row) =>
        row.map((cell) => {
          if (cell === null || cell === undefined) return '';
          if (cell instanceof Date) return cell.toISOString().slice(0, 10);
          if (typeof cell === 'boolean') return cell ? 'yes' : 'no';
          return String(cell);
        }),
      );
    }
    const text = (await file.text()).replace(/^\uFEFF/u, '');
    const { default: Papa } = await import('papaparse');
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
    return parsed.data.map((row) => row.map((cell) => String(cell ?? '')));
  })();
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
      else reject(new Error(event.data.error ?? 'spreadsheet parse failed'));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || 'spreadsheet worker failed'));
    };
    worker.postMessage({ id, file });
  });
}

export async function readSheetFile(file: File): Promise<string[][]> {
  if (typeof Worker === 'undefined') return readMainThread(file);
  try {
    return await readInWorker(file);
  } catch {
    // A browser that refuses module workers (or a parser that needs the DOM) must not
    // lose the import screen; the file is still small enough for the main-thread path.
    return readMainThread(file);
  }
}
