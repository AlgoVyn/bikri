import { describe, expect, it } from 'vitest';
import { appGate } from './useAppGate.ts';

describe('app gate (SYNC-H4)', () => {
  it('sends a database without a device token back to enrolment', () => {
    expect(
      appGate({
        done: true,
        enrolled: false,
        devTenant: false,
        setupCompleted: true,
      }),
    ).toBe('enrol');
  });

  it('stays on the enrol page while its first snapshot downloads', () => {
    expect(
      appGate({
        done: true,
        enrolled: true,
        devTenant: false,
        setupCompleted: true,
        initialSyncPending: true,
      }),
    ).toBe('enrol');
    expect(
      appGate({
        done: false,
        enrolled: true,
        devTenant: false,
        setupCompleted: false,
        initialSyncPending: true,
      }),
    ).toBe('enrol');
  });

  it('keeps an enrolled live shop in the download state while its first snapshot runs', () => {
    expect(
      appGate({
        done: false,
        enrolled: true,
        devTenant: false,
        setupCompleted: true,
      }),
    ).toBe('loading');
  });

  it('still shows setup for a newly enrolled shop that has not completed setup', () => {
    expect(
      appGate({
        done: false,
        enrolled: true,
        devTenant: false,
        setupCompleted: false,
      }),
    ).toBe('setup');
  });

  it('opens the app when the shop row is present and keeps the dev shop working', () => {
    expect(
      appGate({
        done: true,
        enrolled: true,
        devTenant: false,
        setupCompleted: true,
      }),
    ).toBe('ready');
    expect(
      appGate({
        done: false,
        enrolled: false,
        devTenant: true,
        setupCompleted: false,
      }),
    ).toBe('setup');
  });
});
