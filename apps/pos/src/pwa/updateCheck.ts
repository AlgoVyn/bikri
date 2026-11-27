/**
 * Service-worker update checks (D-251, D-300).
 *
 * A till can stay open for days or weeks, so registering the worker once at start is not
 * enough: an always-open standalone window may never see the next deploy. Check once the
 * page's registration is ready, hourly while the page is open, and again when it becomes
 * visible. Visibility checks share a short minimum gap so switching tabs does not hammer
 * the network; the browser still performs its own update checks for installed PWAs.
 *
 * The startup check matters: reloading a controlled page does not bypass the old worker
 * (it answers the navigation with its precached index.html), and the browser's own
 * navigation check is throttled, so without it a till opened after a deploy could sit on
 * the old build for an hour or more.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
export const UPDATE_CHECK_MIN_GAP_MS = 5 * 60 * 1_000;

let cleanup: (() => void) | null = null;

/**
 * Checks the active registration once. A missing registration (first load, dev) and an
 * offline failure are both normal on a till, so they stay silent; the next check retries.
 */
async function checkOnce(): Promise<boolean> {
  const registration = await navigator.serviceWorker?.getRegistration();
  if (registration === undefined) return false;
  await registration.update();
  return true;
}

/**
 * Starts the startup, hourly and visibility checks. Idempotent: calling it again returns
 * the same cleanup function. Returns a function that stops all checks.
 */
export function startUpdateChecks(
  options: { skipStartupCheck?: boolean } = {},
): () => void {
  if (cleanup !== null) return cleanup;
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    cleanup = () => {
      cleanup = null;
    };
    return cleanup;
  }

  let lastCheckAt = 0;
  let inFlight = false;
  let active = true;

  const check = async (): Promise<void> => {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      if (await checkOnce()) lastCheckAt = Date.now();
    } catch {
      // Offline is normal on a till; the next hourly/visible/online check retries.
    } finally {
      inFlight = false;
    }
  };

  // Check as soon as this page has an active registration. A fresh page load is usually
  // the moment a till comes back after the shop closed, so this is when a deploy that
  // happened meanwhile must surface. `registerSW` already performs the registration
  // update on startup, so skip this duplicate check when called from there.
  const ready = navigator.serviceWorker.ready;
  if (!options.skipStartupCheck && ready !== undefined) {
    void ready
      .then(() => {
        if (active) void check();
      })
      .catch(() => undefined);
  }

  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheckAt < UPDATE_CHECK_MIN_GAP_MS) return;
    void check();
  };
  const onOnline = (): void => {
    lastCheckAt = 0;
    void check();
  };

  const timer = window.setInterval(() => {
    void check();
  }, UPDATE_CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);

  cleanup = () => {
    active = false;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    cleanup = null;
  };
  return cleanup;
}

/** Stops the checks; used by tests and a future teardown path. */
export function stopUpdateChecks(): void {
  cleanup?.();
}
