export const PERSIST_KEY = 'bikri.persist';

/** First run only: ask for persistent storage and remember the boolean. */
export async function rememberPersistentStorage(): Promise<boolean> {
  const existing = localStorage.getItem(PERSIST_KEY);
  if (existing === 'true' || existing === 'false') {
    return existing === 'true';
  }
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
