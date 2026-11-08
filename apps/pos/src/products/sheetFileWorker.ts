/**
 * Spreadsheet parsing in a worker (08 §7): a 5,000-row XLSX must not block the counter.
 * The parsers are imported inside the worker, so they also stay out of the route chunk.
 */
type SheetRequest = { id: number; file: File };

type SheetResponse =
  | { id: number; grid: string[][] }
  | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SheetRequest>) => void) | null;
  postMessage: (message: SheetResponse) => void;
};

scope.onmessage = (event: MessageEvent<SheetRequest>) => {
  const { id, file } = event.data;
  void (async () => {
    try {
      scope.postMessage({ id, grid: await read(file) });
    } catch (error) {
      scope.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};

async function read(file: File): Promise<string[][]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) {
    const { readSheet } = await import('read-excel-file/web-worker');
    const data = await readSheet(file);
    return data.map((row) =>
      row.map((cell: unknown) => {
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
}
