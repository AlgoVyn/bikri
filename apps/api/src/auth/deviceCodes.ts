/** Device codes per branch: 'A'..'Z', then 'AA', 'AB', … (02 §2 devices); never reused. */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function codeFromIndex(index: number): string {
  let n = index;
  let out = '';
  do {
    out = LETTERS[n % 26] + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export function indexOfCode(code: string): number {
  if (!/^[A-Z]{1,3}$/u.test(code)) return -1;
  let n = 0;
  for (const ch of code) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The next code after every code already used in the branch. */
export function nextDeviceCode(used: Iterable<string>): string {
  let max = -1;
  for (const code of used) max = Math.max(max, indexOfCode(code));
  return codeFromIndex(max + 1);
}

/** Device code inside an invoice number '<prefix>-<code>-<seq>'. */
export function codeOfInvoice(invoiceNo: string): string | null {
  const m = /^[A-Z0-9]{1,6}-([A-Z]{1,3})-\d+$/u.exec(invoiceNo);
  return m?.[1] ?? null;
}
