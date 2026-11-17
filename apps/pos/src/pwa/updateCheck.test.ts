import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startUpdateChecks,
  stopUpdateChecks,
  UPDATE_CHECK_INTERVAL_MS,
} from './updateCheck.ts';

function stubServiceWorker(
  getRegistration: () => Promise<ServiceWorkerRegistration | undefined>,
): void {
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration } });
}

function fakeRegistration(
  update: () => Promise<void>,
): ServiceWorkerRegistration {
  return { update } as unknown as ServiceWorkerRegistration;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'));
  stopUpdateChecks();
});

afterEach(() => {
  stopUpdateChecks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startUpdateChecks', () => {
  it('checks the registration once an hour', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker(() => Promise.resolve(fakeRegistration(update)));

    startUpdateChecks();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
    await flushPromises();
    expect(update).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('checks when the till becomes visible, with a short minimum gap', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker(() => Promise.resolve(fakeRegistration(update)));

    startUpdateChecks();
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();

    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();
  });

  it('does not check while the till is hidden', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker(() => Promise.resolve(fakeRegistration(update)));
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');

    startUpdateChecks();
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).not.toHaveBeenCalled();

    visibility.mockRestore();
  });

  it('stays silent when there is no registration, and retries on the next check', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const getRegistration = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(fakeRegistration(update));
    stubServiceWorker(getRegistration);

    startUpdateChecks();
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).not.toHaveBeenCalled();

    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();
  });

  it('swallows an offline failure and awaits the next interval', async () => {
    const update = vi.fn().mockRejectedValue(new Error('offline'));
    stubServiceWorker(() => Promise.resolve(fakeRegistration(update)));

    startUpdateChecks();
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();

    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('is idempotent and stops both the timer and the listener', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker(() => Promise.resolve(fakeRegistration(update)));

    const first = startUpdateChecks();
    expect(startUpdateChecks()).toBe(first);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();

    first();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();
  });
});
