import { businessDate } from '@bikri/core';
import { useEffect, useState } from 'react';

function previousDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * The shop's business date, refreshed when midnight passes. An always-on till
 * must start the new day's "today" without an unrelated re-render.
 */
export function useBusinessDates(timeZone: string): {
  today: string;
  yesterday: string;
  now: number;
} {
  const [state, setState] = useState(() => {
    const now = Date.now();
    const today = businessDate(now, timeZone);
    return { zone: timeZone, today, yesterday: previousDate(today), now };
  });
  useEffect(() => {
    const tick = () =>
      setState((prev) => {
        const now = Date.now();
        const today = businessDate(now, timeZone);
        if (prev.today === today && prev.zone === timeZone) return prev;
        return {
          zone: timeZone,
          today,
          yesterday: previousDate(today),
          now,
        };
      });
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [timeZone]);
  return { today: state.today, yesterday: state.yesterday, now: state.now };
}
