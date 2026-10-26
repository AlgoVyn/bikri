import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSIST_KEY, rememberPersistentStorage } from './persist.ts';

function installStorage(): void {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  });
  vi.stubGlobal('navigator', { storage: {} });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rememberPersistentStorage', () => {
  it('calls persist once and stores the result', async () => {
    installStorage();
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', { storage: { persist } });
    await expect(rememberPersistentStorage()).resolves.toBe(true);
    expect(localStorage.getItem(PERSIST_KEY)).toBe('true');
    await expect(rememberPersistentStorage()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('remembers a refusal', async () => {
    installStorage();
    const persist = vi.fn().mockResolvedValue(false);
    vi.stubGlobal('navigator', { storage: { persist } });
    await expect(rememberPersistentStorage()).resolves.toBe(false);
    expect(localStorage.getItem(PERSIST_KEY)).toBe('false');
  });
});
