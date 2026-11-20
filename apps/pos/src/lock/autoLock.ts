/** Auto-lock after idle minutes and Ctrl+L (05 §4); only for an enrolled shop (D-109). */
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect } from 'react';
import {
  autoLockMinutes,
  effectiveAutoLockMinutes,
  shouldAutoLock,
} from '../data/autoLock.ts';
import { getDb } from '../data/db.ts';
import { useSession } from '../state/session.ts';

export function useAutoLock(enabled: boolean): void {
  const session = useSession((s) => s.session);
  const lock = useSession((s) => s.lock);
  // Runs at the root before enrolment, where there is no tenant DB yet.
  const configured =
    useLiveQuery(async () => {
      try {
        return await autoLockMinutes(getDb());
      } catch {
        return 10;
      }
    }, [enabled]) ?? 10;
  useEffect(() => {
    if (!enabled || !session) return;
    const role = session.role;
    const minutes = effectiveAutoLockMinutes(configured, role);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastActivityAt = Date.now();
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (minutes <= 0) return;
      const remaining = minutes * 60_000 - (Date.now() - lastActivityAt);
      if (remaining <= 0) {
        lock();
        return;
      }
      timer = setTimeout(lock, remaining);
    };
    const activity = () => {
      lastActivityAt = Date.now();
      schedule();
    };
    const check = () => {
      if (
        document.visibilityState === 'visible' &&
        shouldAutoLock(configured, role, Date.now() - lastActivityAt)
      ) {
        lock();
        return;
      }
      schedule();
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        lock();
        return;
      }
      activity();
    };
    const events = ['pointerdown', 'wheel', 'touchstart'] as const;
    for (const ev of events)
      window.addEventListener(ev, activity, { passive: true });
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, activity);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [enabled, session, lock, configured]);
}
