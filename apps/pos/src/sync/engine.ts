/**
 * Sync scheduling (03 §6): push after writes (5 s debounce), push+pull every poll interval while
 * visible and online, on `online` and on becoming visible; exponential backoff on errors.
 */
import type { BikriDb } from '@bikri/db';
import { getKv, setKv } from '../data/kv.ts';
import { onLocalWrite } from '../data/write.ts';
import { deviceToken, OfflineError, SyncHttpError } from './client.ts';
import { uploadQueued } from './files.ts';
import { refreshMe } from './me.ts';
import { pullAll } from './pull.ts';
import { pushAll } from './push.ts';
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
  return current ? current.run('full') : Promise.resolve();
}

let current: SyncEngine | null = null;
onLocalWrite(() => notifyLocalWrite());

export class SyncEngine {
  readonly db: BikriDb;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private failures = 0;
  private stopped = false;
  private readonly onOnline = () => void this.run('full');
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') void this.run('pull');
  };

  constructor(db: BikriDb) {
    this.db = db;
  }

  static async start(db: BikriDb): Promise<SyncEngine | null> {
    if (!(await deviceToken(db))) return null;
    current?.stop();
    const engine = new SyncEngine(db);
    current = engine;
    window.addEventListener('online', engine.onOnline);
    document.addEventListener('visibilitychange', engine.onVisible);
    void engine.run('first');
    return engine;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (current === this) current = null;
  }

  schedulePush(): void {
    if (this.stopped) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.run('push'), WRITE_DEBOUNCE_MS);
  }

  private async scheduleNext(delay?: number): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const poll =
      delay ?? (await getKv<number>(this.db, 'poll_after_ms', 60_000));
    this.timer = setTimeout(() => {
      if (document.visibilityState === 'hidden') void this.scheduleNext();
      else void this.run('full');
    }, poll);
  }

  run(kind: 'first' | 'full' | 'push' | 'pull'): Promise<void> {
    if (this.running) return this.running;
    this.running = this.cycle(kind).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async cycle(kind: 'first' | 'full' | 'push' | 'pull'): Promise<void> {
    const state = useSyncState.getState();
    if (this.stopped) return;
    if (!navigator.onLine) {
      state.set({ phase: 'offline' });
      await this.scheduleNext();
      return;
    }
    if (state.phase === 'revoked' || state.phase === 'outdated') return;
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
      await this.scheduleNext();
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
