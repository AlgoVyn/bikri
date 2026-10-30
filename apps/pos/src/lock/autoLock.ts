/** Auto-lock after idle minutes and Ctrl+L (05 §4); only for an enrolled shop (D-109). */
import { useEffect } from 'react';
import { autoLockMinutes } from '../data/autoLock.ts';
import { getDb } from '../data/db.ts';
import { useSession } from '../state/session.ts';

export function useAutoLock(enabled: boolean): void {
  const session = useSession((s) => s.session);
  const lock = useSession((s) => s.lock);
  useEffect(() => {
    if (!enabled || !session) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let minutes = 10;
    let alive = true;
    const arm = () => {
      if (timer) clearTimeout(timer);
      if (minutes > 0) timer = setTimeout(lock, minutes * 60_000);
    };
    void autoLockMinutes(getDb()).then((m) => {
      if (!alive) return;
      minutes = m === 0 && session.role !== 'owner' ? 10 : m;
      arm();
    });
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        lock();
        return;
      }
      arm();
    };
    const events = ['pointerdown', 'wheel', 'touchstart'] as const;
    for (const ev of events)
      window.addEventListener(ev, arm, { passive: true });
    window.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, arm);
      window.removeEventListener('keydown', onKey);
    };
  }, [enabled, session, lock]);
}
