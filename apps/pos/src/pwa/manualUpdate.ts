import { getUpdateSnapshot, setUpdateReady } from './updateStore.ts';

export type UpdateCheck =
  | 'latest'
  | 'ready'
  | 'offline'
  | 'unavailable'
  | 'error';

const DEFAULT_TIMEOUT_MS = 15_000;
/** `registration.update()` resolves after the check; let a queued `updatefound` land. */
const UPDATE_FOUND_GRACE_MS = 150;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

/** Waits for an installing worker to reach `installed` (or fail). */
function waitForInstalled(
  worker: ServiceWorker,
  timeoutMs: number,
): Promise<boolean> {
  if (worker.state === 'installed') return Promise.resolve(true);
  if (worker.state === 'redundant') return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer = 0;
    const finish = (value: boolean): void => {
      window.clearTimeout(timer);
      worker.removeEventListener('statechange', onState);
      resolve(value);
    };
    const onState = (): void => {
      if (worker.state === 'installed') finish(true);
      else if (worker.state === 'redundant') finish(false);
    };
    worker.addEventListener('statechange', onState);
    timer = window.setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Checks for a new service worker on demand (Settings → About). The automatic
 * checks in updateCheck.ts keep running; this only lets the user ask now.
 *
 * `registration.update()` resolving does not mean a new worker is ready, so wait
 * for `installing`/`waiting` before reporting `ready`. A missing registration is
 * normal in development and on the very first load; the screen offers a reload.
 */
export async function checkForUpdate(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<UpdateCheck> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return 'unavailable';
  }

  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await navigator.serviceWorker.getRegistration();
  } catch {
    return 'error';
  }
  if (!registration) return 'unavailable';
  if (registration.waiting) {
    setUpdateReady(true);
    return 'ready';
  }

  try {
    await registration.update();
  } catch {
    return navigator.onLine ? 'error' : 'offline';
  }

  // A first install is not an update: the page already loaded the current build.
  // The initial worker activates instead of waiting, so there is nothing to restart.
  if (!registration.active) return 'latest';

  // Chromium usually sets `installing` before update() resolves; the short grace
  // covers a queued `updatefound` event on the other engines.
  if (!registration.waiting && !registration.installing) {
    await wait(UPDATE_FOUND_GRACE_MS);
  }
  if (registration.waiting) {
    setUpdateReady(true);
    return 'ready';
  }
  if (!registration.installing) {
    return getUpdateSnapshot().updateReady ? 'ready' : 'latest';
  }

  const installed = await waitForInstalled(registration.installing, timeoutMs);
  if (!installed) return 'error';
  setUpdateReady(true);
  return 'ready';
}
