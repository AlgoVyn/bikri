/** CSV helpers shared by every local export (REQ-B02). Amounts are rupees, quantities decimal. */

/** One cell: quotes separators and neutralises spreadsheet formula injection. */
export function csvCell(value: unknown): string {
  let s = String(value ?? '');
  // Spreadsheet formula injection: text starting with = + - @ is prefixed with '.
  if (typeof value === 'string' && /^[=+\-@]/u.test(s)) s = `'${s}`;
  return /[",\n\r]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
}

/** Paisa → `1234.5` / `1234.50` without a currency label. */
export function rupeesCsv(paisa: number): string {
  return (paisa / 100).toFixed(2).replace(/\.00$/u, '');
}

/** Milli-units → `3` / `2.5`. */
export function qtyCsv(milli: number): string {
  return String(milli / 1000);
}

/** Paisa → rupees with exactly two decimals (`43000.00`), for report exports (screens/16 AC 6). */
export function rupeesCsv2(paisa: number): string {
  return (paisa / 100).toFixed(2);
}
