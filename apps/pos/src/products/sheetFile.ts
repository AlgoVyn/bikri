/** Reads a CSV or XLSX file into a grid of strings; the parsers load on first use. */
export async function readSheetFile(file: File): Promise<string[][]> {
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
  return parsed.data.map((row) => row.map((c) => String(c ?? '')));
}
