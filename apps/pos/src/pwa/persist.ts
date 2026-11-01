export const PERSIST_KEY = 'bikri.persist';

/** First run only: ask for persistent storage and remember the boolean. */
export async function rememberPersistentStorage(): Promise<boolean> {
  // A `false` is not permanent: ask again on the next launch (the PWA may now be
  // installed and eligible), never cache the denial as a final answer.
  if (localStorage.getItem(PERSIST_KEY) === 'true') return true;
  let granted = false;
  try {
    const persist = navigator.storage?.persist;
    if (persist !== undefined) {
      granted = await persist.call(navigator.storage);
    }
  } catch {
    granted = false;
  }
  localStorage.setItem(PERSIST_KEY, granted ? 'true' : 'false');
  return granted;
}
