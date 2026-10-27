/** Saves text as a file through a temporary link (CSV exports, REQ-B02). */
export function downloadText(
  filename: string,
  text: string,
  type = 'text/csv;charset=utf-8',
): void {
  const blob = new Blob([`\uFEFF${text}`], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
