/**
 * Share grace (03 §6): the sale-complete and bill **Share** buttons open WhatsApp (or
 * the OS share sheet) in another tab, which hides the till. Chromium can suspend a
 * request started while hidden until its HTTP/3 connection idles out, so sync waits for
 * a short window after a share. Ordinary hidden tabs (minimised window, another app in
 * front, locked screen) keep syncing; the request timeout is the safety net there.
 */
export const SHARE_SYNC_DEFER_MS = 30_000;

let shareOpenedAt: number | null = null;

/** Called by `openShareWindow()` before the external tab hides the till. */
export function noteShareOpened(now = Date.now()): void {
  shareOpenedAt = now;
}

export function shareGraceActive(now = Date.now()): boolean {
  return shareOpenedAt !== null && now - shareOpenedAt < SHARE_SYNC_DEFER_MS;
}
