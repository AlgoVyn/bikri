/**
 * Sync scheduling (03 §6): push after writes (5 s debounce), push+pull every poll interval while
 * online, on `online`, on becoming visible and on `pagehide`; exponential backoff on errors.
 * A short grace window after a Share keeps requests out of a hidden tab that Chromium may
 * suspend (see `shareGrace.ts`); ordinary hidden tabs keep syncing.
 */
import type { BikriDb } from '@bikri/db';
import { getKv, setKv } from '../data/kv.ts';
import { onLocalWrite } from '../data/write.ts';
import { deviceToken, OfflineError, SyncHttpError } from './client.ts';
import { uploadQueued } from './files.ts';
import { refreshMe } from './me.ts';
import { pullAll } from './pull.ts';
import { pushAll } from './push.ts';
import { shareGraceActive } from './shareGrace.ts';
import { useSyncState } from './state.ts';

export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
export const WRITE_DEBOUNCE_MS = 5_000;
const CLOCK_SKEW_LIMIT_MS = 5 * 60_000;

export function backoffDelay(failures: number): number {
  return (
    BACKOFF_MS[Math.min(Math.max(failures - 1, 0), BACKOFF_MS.length - 1)] ??
    300_000
  );
}

/** Tells the engine local data changed (repository writes call this). */
export function notifyLocalWrite(): void {
  current?.schedulePush();
}

/** Manual "Sync now" and day close. */
export function syncNow(): Promise<void> {
  // A manual sync must include every op queued before the call, even if an automatic
  // cycle is already running. The follow-up cycle is cheap when there is nothing left.
  return current ? current.run('full', true) : Promise.resolve();
}

let current: SyncEngine | null = null;
onLocalWrite(() => notifyLocalWrite());

export class SyncEngine {
  readonly db: BikriDb;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private runningKind: 'first' | 'full' | 'push' | 'pull' | null = null;
  private failures = 0;
  private stopped = false;
  /** A cycle was skipped because the till was hidden; flush it when the till returns. */
  private deferredCycle = false;
  private readonly onOnline = () => void this.run('full');
  private readonly onPageHide = () => {
    // Best effort: a phone browser may freeze the page after this event, but a last
    // push often still completes before the tab is discarded.
    if (!this.stopped) void this.run('push', true);
  };
  private readonly onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    // A Share hides the till while WhatsApp opens in another tab; requests started then
    // can sit suspended until their HTTP/3 connection idles out. Those cycles wait for
    // this flush. Ordinary background time (minimised window, locked screen) syncs.
    if (this.deferredCycle) {
      this.deferredCycle = false;
      // Forced: a cycle that was already in flight may have pushed before the write
      // that was deferred here, so its promise does not include the new ops.
      void this.run('full', true);
    } else {
      void this.run('pull');
    }
  };

  /** Hidden by the Share sheet, where a fresh request may be suspended. */
  private shareHidden(): boolean {
    return document.visibilityState === 'hidden' && shareGraceActive();
  }

  constructor(db: BikriDb) {
    this.db = db;
  }

  static async start(db: BikriDb): Promise<SyncEngine | null> {
    if (!(await deviceToken(db))) return null;
    current?.stop();
    const engine = new SyncEngine(db);
    current = engine;
    window.addEventListener('online', engine.onOnline);
    window.addEventListener('pagehide', engine.onPageHide);
    document.addEventListener('visibilitychange', engine.onVisible);
    void engine.run('first');
    return engine;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (current === this) current = null;
  }

  schedulePush(): void {
    if (this.stopped) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    // Start the debounced push when the till is visible, or after the Share grace has
    // passed: only a request started right after Share may be suspended by Chromium.
    if (this.shareHidden()) {
      this.deferredCycle = true;
      return;
    }
    this.pushTimer = setTimeout(
      () => void this.run('push', true),
      WRITE_DEBOUNCE_MS,
    );
  }

  private async scheduleNext(delay?: number): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const poll =
      delay ?? (await getKv<number>(this.db, 'poll_after_ms', 60_000));
    this.timer = setTimeout(() => {
      if (this.shareHidden()) void this.scheduleNext();
      else void this.run('full');
    }, poll);
  }

  run(kind: 'first' | 'full' | 'push' | 'pull', force = false): Promise<void> {
    if (this.running) {
      // A forced sync (manual "Sync now" or a write-debounced push) must not be dropped
      // because an automatic cycle is in flight: the running cycle may have already
      // passed its push, so its promise does not include the newest outbox rows.
      if (force) return this.running.then(() => this.run(kind, true));
      // A write-debounced push must not be dropped because a pull (or another push) is in
      // flight, and a manual full sync requested during one must still pull afterwards.
      // `first`/`full` already push and pull, so chaining onto them would only duplicate work.
      const busy = this.runningKind !== 'first' && this.runningKind !== 'full';
      if (kind === 'push' && busy)
        return this.running.then(() => this.run('push'));
      if (kind === 'full' && busy)
        return this.running.then(() => this.run('full'));
      return this.running;
    }
    this.runningKind = kind;
    this.running = this.cycle(kind).finally(() => {
      this.running = null;
      this.runningKind = null;
    });
    return this.running;
  }

  private async cycle(kind: 'first' | 'full' | 'push' | 'pull'): Promise<void> {
    const state = useSyncState.getState();
    if (this.stopped) return;
    // Opening a share window hides the till for a short grace; do not start requests
    // that Chromium may suspend until the HTTP/3 connection times out. Ordinary hidden
    // tabs keep syncing, and `onVisible` flushes a deferred cycle.
    if (this.shareHidden()) {
      this.deferredCycle = true;
      return;
    }
    if (!navigator.onLine) {
      state.set({ phase: 'offline' });
      await this.scheduleNext();
      return;
    }
    if (state.phase === 'revoked' || state.phase === 'outdated') return;
    // Never push recovery ops before their restored snapshot is complete: their local
    // tables and caches are still empty/incomplete until the snapshot settles them.
    if (
      kind !== 'pull' &&
      (await getKv<boolean>(this.db, 'recovery_pending', false))
    )
      kind = 'pull';
    state.set({ phase: 'syncing', error: null });
    try {
      let serverTime: number | null = null;
      if (kind === 'first') serverTime = (await refreshMe(this.db)).server_time;
      if (kind !== 'pull') {
        const pushed = await pushAll(this.db);
        serverTime = pushed.serverTime ?? serverTime;
        await uploadQueued(this.db);
      }
      if (kind !== 'push') {
        const pulled = await pullAll(this.db, (done, total) =>
          useSyncState
            .getState()
            .set({ phase: 'downloading', progress: { done, total } }),
        );
        serverTime = pulled ?? serverTime;
      }
      this.failures = 0;
      const now = Date.now();
      await setKv(this.db, 'last_sync_at', now);
      if (serverTime !== null) {
        const skew = now - serverTime;
        const prev = await getKv<number>(this.db, 'clock_skew_ms', 0);
        if (
          Math.abs(skew - prev) > 60_000 ||
          (prev !== 0 && Math.abs(skew) < 60_000)
        )
          await setKv(
            this.db,
            'clock_skew_ms',
            Math.abs(skew) < 60_000 ? 0 : skew,
          );
      }
      useSyncState.getState().set({
        phase: 'idle',
        lastSyncAt: now,
        progress: null,
        quotaUntil: null,
        clockSkewMs: serverTime === null ? 0 : now - serverTime,
      });
      // A write-debounced push must not restart the poll timer: a till that sells
      // more often than the poll interval would otherwise push forever and never
      // pull the other tills' sales, refunds and stock (D-231).
      if (kind !== 'push') await this.scheduleNext();
    } catch (error) {
      await this.handle(error);
    }
  }

  private async handle(error: unknown): Promise<void> {
    const set = useSyncState.getState().set;
    if (error instanceof OfflineError) {
      set({ phase: 'offline', progress: null });
      this.failures += 1;
      await this.scheduleNext(backoffDelay(this.failures));
      return;
    }
    if (error instanceof SyncHttpError) {
      if (error.code === 'DEVICE_REVOKED' || error.code === 'UNAUTHENTICATED') {
        await setKv(this.db, 'revoked', { at: Date.now(), code: error.code });
        set({ phase: 'revoked', error: error.code, progress: null });
        this.stop();
        return;
      }
      if (error.code === 'SCHEMA_OUTDATED') {
        set({ phase: 'outdated', error: error.code, progress: null });
        return;
      }
      if (error.code === 'TENANT_READ_ONLY') {
        await setKv(this.db, 'tenant_status', {
          status: 'read_only',
          since: (error.details.since as number | undefined) ?? null,
          learned_at: Date.now(),
        });
        set({ phase: 'idle', progress: null });
        // Pulls continue in read-only mode.
        try {
          await pullAll(this.db);
        } catch {
          /* next tick */
        }
        await this.scheduleNext();
        return;
      }
      if (error.code === 'TENANT_SUSPENDED') {
        set({ phase: 'suspended', error: error.code, progress: null });
        await this.scheduleNext(300_000);
        return;
      }
      // D1_LIMIT: the whole account is out of daily rows; same wait as a shop quota (04 §3).
      if (error.code === 'TENANT_QUOTA' || error.code === 'D1_LIMIT') {
        const wait = (error.retryAfter ?? 3600) * 1000;
        set({ phase: 'quota', quotaUntil: Date.now() + wait, progress: null });
        await this.scheduleNext(Math.min(wait, 3_600_000));
        return;
      }
    }
    this.failures += 1;
    set({
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
      progress: null,
    });
    await this.scheduleNext(backoffDelay(this.failures));
  }
}

export const CLOCK_SKEW_WARNING_MS = CLOCK_SKEW_LIMIT_MS;
