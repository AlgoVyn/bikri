import { create } from 'zustand';

/** What the rail badge shows (03 §7). */
export type SyncPhase =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'outdated'
  | 'downloading'
  | 'quota'
  | 'revoked'
  | 'suspended';

export type SyncState = {
  phase: SyncPhase;
  lastSyncAt: number | null;
  error: string | null;
  /** Snapshot progress 0–1 while downloading. */
  progress: { done: number; total: number } | null;
  /** UTC midnight when the daily limit resets (503 TENANT_QUOTA). */
  quotaUntil: number | null;
  /** device clock − server time, ms (03 §6 clock check). */
  clockSkewMs: number;
  set: (patch: Partial<Omit<SyncState, 'set'>>) => void;
};

export const useSyncState = create<SyncState>((set) => ({
  phase: 'idle',
  lastSyncAt: null,
  error: null,
  progress: null,
  quotaUntil: null,
  clockSkewMs: 0,
  set: (patch) => set(patch),
}));
