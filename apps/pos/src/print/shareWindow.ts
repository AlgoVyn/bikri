/**
 * Opens a blank tab during the click that starts a share. Building the receipt image
 * takes several awaits, after which `window.open` is no longer user-initiated and most
 * browsers block it. Navigating the pre-opened tab keeps the WhatsApp draft working.
 */
export function openShareWindow(): Window | null {
  if (typeof window === 'undefined') return null;
  try {
    const win = window.open('about:blank', '_blank');
    if (win) win.opener = null;
    return win;
  } catch {
    return null;
  }
}

export function navigateShareWindow(win: Window | null, url: string): boolean {
  if (win === null || win.closed) return false;
  win.location.href = url;
  return true;
}

export function closeShareWindow(win: Window | null): void {
  if (win !== null && !win.closed) win.close();
}
