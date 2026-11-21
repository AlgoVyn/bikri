export const PERSIST_KEY = 'bikri.persist';

/** First run only: ask for persistent storage and remember the boolean. */
function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private/restricted webviews throw on access; persistence is best-effort.
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The answer is only a cache; a blocked store must not reject this promise.
  }
}

export async function rememberPersistentStorage(): Promise<boolean> {
  // A `false` is not permanent: ask again on the next launch (the PWA may now be
  // installed and eligible), never cache the denial as a final answer.
  if (storageGet(PERSIST_KEY) === 'true') return true;
  let granted = false;
  try {
    const persist = navigator.storage?.persist;
    if (persist !== undefined) {
      granted = await persist.call(navigator.storage);
    }
  } catch {
    granted = false;
  }
  storageSet(PERSIST_KEY, granted ? 'true' : 'false');
  return granted;
}
