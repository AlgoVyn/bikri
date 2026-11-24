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
import { applyStatus, isReadOnly } from './status.ts';

export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
export const WRITE_DEBOUNCE_MS = 5_000;
/** An idle till backs off to 5 min; a hidden one always waits 5 min. */
export const IDLE_POLL_MAX_MS = 300_000;
const CLOCK_SKEW_LIMIT_MS = 5 * 60_000;

/**
 * Poll interval after `emptyPolls` consecutive pulls with no rows. Hidden tills use the
 * maximum; visible tills double from the server value up to 5 min. A local write,
 * visible/online transition or a pull with rows resets `emptyPolls` to 0.
 */
export function nextPollDelay(
  base: number,
  emptyPolls: number,
  hidden: boolean,
): number {
  if (hidden) return IDLE_POLL_MAX_MS;
  const doublings = Math.min(Math.max(emptyPolls, 0), 4);
  return Math.min(base * 2 ** doublings, IDLE_POLL_MAX_MS);
}

export function backoffDelay(failures: number): number {
  return (
    BACKOFF_MS[Math.min(Math.max(failures - 1, 0), BACKOFF_MS.length - 1)] ??
    300_000
  );
}

type RunKind = 'first' | 'full' | 'push' | 'pull';

/** `full` subsumes `push`/`pull`, `push` subsumes `pull`; `first` behaves like `full`. */
export function mergeRun(pending: RunKind | null, kind: RunKind): RunKind {
  if (pending === null) return kind;
  // A queued push and pull must both run; collapsing to `push` used to drop the pull.
  if (
    (pending === 'push' && kind === 'pull') ||
    (pending === 'pull' && kind === 'push')
  )
    return 'full';
  const rank = (value: RunKind): number =>
    value === 'first' || value === 'full' ? 2 : value === 'push' ? 1 : 0;
  return rank(kind) > rank(pending) ? kind : pending;
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
  /** One coalesced follow-up for work requested while a cycle is in flight. */
  private queued: 'first' | 'full' | 'push' | 'pull' | null = null;
  private failures = 0;
  /** Consecutive pulls that returned no rows; drives the idle back-off. */
  private emptyPolls = 0;
  private stopped = false;
  /** A cycle was skipped because the till was hidden; flush it when the till returns. */
  private deferredCycle = false;
  private readonly onOnline = () => {
    this.emptyPolls = 0;
    void this.run('full');
  };
  private readonly onPageHide = () => {
    // Best effort: a phone browser may freeze the page after this event, but a last
    // push often still completes before the tab is discarded.
    if (!this.stopped) void this.run('push', true);
  };
  private readonly onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    this.emptyPolls = 0;
    // A Share hides the till while WhatsApp opens in another tab; requests started then
    // can sit suspended until their HTTP/3 connection idles out. Those cycles wait for
    // this flush. Ordinary background time (minimised window, locked screen) syncs.
    if (this.deferredCycle) {
      this.deferredCycle = false;
      // Forced: a cycle that was already in flight may have pushed before the write
      // that was deferred here, so its promise does not include the new ops.
      void this.run('full', true);
    } else {
      // A pull only would leave a lost/merged push unresolved until the next poll. If
      // anything is waiting, settle the outbox first and pull afterwards.
      void this.flushOnVisible().catch(() => undefined);
    }
  };

  private async flushOnVisible(): Promise<void> {
    const [pending, sending] = await Promise.all([
      this.db.outbox.where('status').equals('pending').count(),
      this.db.outbox.where('status').equals('sending').count(),
    ]);
    await this.run(pending + sending > 0 ? 'full' : 'pull');
  }

  /** Hidden by the Share sheet, where a fresh request may be suspended. */
  private shareHidden(): boolean {
    return document.visibilityState === 'hidden' && shareGraceActive();
  }

  constructor(db: BikriDb) {
    this.db = db;
  }

  static async start(db: BikriDb): Promise<SyncEngine | null> {
    if (!(await deviceToken(db))) return null;
    // Enrolment owns the very first download (SYNC-H4): a competing engine would push
    // and pull the same empty tenant while the enrol page is still downloading it.
    if (await getKv<boolean>(db, 'initial_sync_pending', false)) return null;
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
    this.emptyPolls = 0;
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
    const base =
      delay !== undefined
        ? delay
        : await getKv<number>(this.db, 'poll_after_ms', 60_000);
    const poll =
      delay ??
      nextPollDelay(
        base,
        this.emptyPolls,
        document.visibilityState === 'hidden',
      );
    this.timer = setTimeout(() => {
      if (this.shareHidden()) void this.scheduleNext();
      else void this.run('full');
    }, poll);
  }

  run(kind: 'first' | 'full' | 'push' | 'pull', _force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      // Coalesce into one follow-up instead of chaining a new run per request. A forced
      // sync (manual "Sync now" or a write-debounced push) must still run after the
      // cycle in flight, because that cycle may have passed its push already.
      this.queued = mergeRun(this.queued, kind);
      return this.running;
    }
    return this.startLoop(kind);
  }

  private startLoop(kind: 'first' | 'full' | 'push' | 'pull'): Promise<void> {
    const loop = async (): Promise<void> => {
      let next: 'first' | 'full' | 'push' | 'pull' | null = kind;
      try {
        while (next !== null && !this.stopped) {
          await this.cycle(next);
          next = this.queued;
          this.queued = null;
        }
      } finally {
        this.running = null;
        this.queued = null;
      }
    };
    this.running = loop();
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
        // A read-only shop rejects every upload with 403; the queue stays pending and
        // resumes once the shop is active again (13 §7.2).
        if (!(await isReadOnly(this.db))) await uploadQueued(this.db);
      }
      if (kind !== 'push') {
        let received = 0;
        const pulled = await pullAll(
          this.db,
          (done, total) =>
            useSyncState
              .getState()
              .set({ phase: 'downloading', progress: { done, total } }),
          (count) => {
            received += count;
          },
        );
        this.emptyPolls = received > 0 ? 0 : this.emptyPolls + 1;
        serverTime = pulled ?? serverTime;
      }
      this.failures = 0;
      const sync = await this.recordSyncTime(serverTime);
      useSyncState.getState().set({
        phase: 'idle',
        progress: null,
        quotaUntil: null,
        ...sync,
      });
      // A write-debounced push must not restart the poll timer: a till that sells
      // more often than the poll interval would otherwise push forever and never
      // pull the other tills' sales, refunds and stock (D-231).
      if (kind !== 'push') await this.scheduleNext();
    } catch (error) {
      await this.handle(error);
    }
  }

  /** Stores "last synced" and the learned clock skew shared by every cycle path. */
  private async recordSyncTime(
    serverTime: number | null,
  ): Promise<{ lastSyncAt: number; clockSkewMs: number }> {
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
    return {
      lastSyncAt: now,
      clockSkewMs: serverTime === null ? 0 : now - serverTime,
    };
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
        // Keep the learned age of the status: this branch runs on every poll while the
        // shop is read-only, and `applyStatus` preserves `learned_at` when nothing changed.
        await applyStatus(this.db, {
          tenant_status: {
            status: 'read_only',
            since: (error.details.since as number | undefined) ?? null,
          },
        });
        set({ phase: 'idle', progress: null });
        // Pulls continue in read-only mode.
        try {
          let received = 0;
          const serverTime = await pullAll(this.db, undefined, (count) => {
            received += count;
          });
          this.emptyPolls = received > 0 ? 0 : this.emptyPolls + 1;
          this.failures = 0;
          set(await this.recordSyncTime(serverTime));
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
    const retryAfter =
      error instanceof SyncHttpError && error.retryAfter !== null
        ? Math.min(error.retryAfter * 1000, 3_600_000)
        : null;
    await this.scheduleNext(retryAfter ?? backoffDelay(this.failures));
  }
}

export const CLOCK_SKEW_WARNING_MS = CLOCK_SKEW_LIMIT_MS;
