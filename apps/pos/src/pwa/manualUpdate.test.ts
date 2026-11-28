import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate } from './manualUpdate.ts';
import { getUpdateSnapshot, resetUpdateStore } from './updateStore.ts';

class FakeWorker {
  state: ServiceWorkerState = 'installing';
  private readonly listeners = new Set<() => void>();

  addEventListener = vi.fn((_type: string, listener: () => void) => {
    this.listeners.add(listener);
  });

  removeEventListener = vi.fn((_type: string, listener: () => void) => {
    this.listeners.delete(listener);
  });

  emit(state: ServiceWorkerState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

type FakeRegistration = {
  active: object | null;
  waiting: FakeWorker | null;
  installing: FakeWorker | null;
  update: ReturnType<typeof vi.fn>;
};

function registration(
  overrides: Partial<FakeRegistration> = {},
): FakeRegistration {
  return {
    active: {},
    waiting: null,
    installing: null,
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function stubServiceWorker(
  reg: FakeRegistration | undefined,
  onLine = true,
): void {
  vi.stubGlobal('navigator', {
    onLine,
    serviceWorker: {
      getRegistration: vi.fn().mockResolvedValue(reg),
      controller: reg?.active ?? null,
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetUpdateStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetUpdateStore();
});

describe('checkForUpdate', () => {
  it('reports unavailable when the browser has no service worker support', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    await expect(checkForUpdate()).resolves.toBe('unavailable');
  });

  it('reports unavailable when this page has no registration', async () => {
    stubServiceWorker(undefined);
    await expect(checkForUpdate()).resolves.toBe('unavailable');
  });

  it('reports ready immediately for a worker that is already waiting', async () => {
    const worker = new FakeWorker();
    worker.state = 'installed';
    const reg = registration({ waiting: worker });
    stubServiceWorker(reg);

    await expect(checkForUpdate()).resolves.toBe('ready');
    expect(reg.update).not.toHaveBeenCalled();
    expect(getUpdateSnapshot().updateReady).toBe(true);
  });

  it('waits for an installing worker to become ready', async () => {
    const worker = new FakeWorker();
    const reg = registration();
    reg.update.mockImplementation(async () => {
      reg.installing = worker;
    });
    stubServiceWorker(reg);

    const result = checkForUpdate();
    await vi.advanceTimersByTimeAsync(0);
    worker.emit('installed');

    await expect(result).resolves.toBe('ready');
    expect(getUpdateSnapshot().updateReady).toBe(true);
  });

  it('reports latest when the browser finds no new worker', async () => {
    const reg = registration();
    stubServiceWorker(reg);

    const result = checkForUpdate();
    await vi.advanceTimersByTimeAsync(150);

    await expect(result).resolves.toBe('latest');
    expect(getUpdateSnapshot().updateReady).toBe(false);
  });

  it('does not treat the first install as an update', async () => {
    const worker = new FakeWorker();
    const reg = registration({ active: null });
    reg.update.mockImplementation(async () => {
      reg.installing = worker;
    });
    stubServiceWorker(reg);

    await expect(checkForUpdate()).resolves.toBe('latest');
    expect(getUpdateSnapshot().updateReady).toBe(false);
  });

  it('reports offline when the update check fails with no network', async () => {
    const reg = registration();
    reg.update.mockRejectedValue(new Error('offline'));
    stubServiceWorker(reg, false);

    await expect(checkForUpdate()).resolves.toBe('offline');
  });

  it('reports an error when the update check fails while online', async () => {
    const reg = registration();
    reg.update.mockRejectedValue(new Error('boom'));
    stubServiceWorker(reg);

    await expect(checkForUpdate()).resolves.toBe('error');
  });

  it('reports an error when the new worker never installs', async () => {
    const worker = new FakeWorker();
    const reg = registration();
    reg.update.mockImplementation(async () => {
      reg.installing = worker;
    });
    stubServiceWorker(reg);

    const result = checkForUpdate(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toBe('error');
    expect(getUpdateSnapshot().updateReady).toBe(false);
  });
});
