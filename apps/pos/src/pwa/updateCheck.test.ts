import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startUpdateChecks,
  stopUpdateChecks,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_MIN_GAP_MS,
} from './updateCheck.ts';

function stubServiceWorker(
  getRegistration: () => Promise<ServiceWorkerRegistration | undefined>,
): void {
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistration,
      // The startup check waits for the active registration, as a real page does.
      ready: Promise.resolve(fakeRegistration(async () => undefined)),
    },
  });
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

/** Lets the startup `ready.then(check)` and its `getRegistration` settle. */
async function settleStartupCheck(): Promise<void> {
  await flushPromises();
  await flushPromises();
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
  it('checks once the registration is ready, then once an hour', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker(() => Promise.resolve(fakeRegistration(update)));

    startUpdateChecks();
    await settleStartupCheck();
    expect(update).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('checks when the till becomes visible, with a short minimum gap', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker(() => Promise.resolve(fakeRegistration(update)));

    startUpdateChecks();
    await settleStartupCheck();
    expect(update).toHaveBeenCalledOnce();

    // The startup check counts towards the gap, so an immediate tab switch is free.
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MIN_GAP_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);

    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('does not run the visibility check while the till is hidden', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker(() => Promise.resolve(fakeRegistration(update)));
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');

    startUpdateChecks();
    await settleStartupCheck();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MIN_GAP_MS);
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();

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
    await settleStartupCheck();
    expect(update).not.toHaveBeenCalled();

    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();
  });

  it('retries an offline failure on visibility and the next interval', async () => {
    const update = vi.fn().mockRejectedValue(new Error('offline'));
    stubServiceWorker(() => Promise.resolve(fakeRegistration(update)));

    startUpdateChecks();
    await settleStartupCheck();
    expect(update).toHaveBeenCalledOnce();

    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('is idempotent and stops the startup check, timer and listener', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    stubServiceWorker(() => Promise.resolve(fakeRegistration(update)));

    const first = startUpdateChecks();
    expect(startUpdateChecks()).toBe(first);

    await settleStartupCheck();
    expect(update).toHaveBeenCalledOnce();

    first();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    await flushPromises();
    expect(update).toHaveBeenCalledOnce();
  });
});
