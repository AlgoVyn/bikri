/** Persisted date-range selection for Sales, Expenses and Reports (device-local). */

export type StoredDateFilter<P extends string> = {
  preset: P;
  from: string;
  to: string;
};

const PREFIX = 'bikri.filter.';
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function readDateFilter<P extends string>(
  key: string,
  allowed: readonly P[],
  fallback: P,
  today: string,
): StoredDateFilter<P> {
  const empty: StoredDateFilter<P> = {
    preset: fallback,
    from: today,
    to: today,
  };
  try {
    const raw = localStorage.getItem(`${PREFIX}${key}`);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredDateFilter<P>>;
    if (!parsed || typeof parsed.preset !== 'string') return empty;
    if (!allowed.includes(parsed.preset as P)) return empty;
    const from =
      typeof parsed.from === 'string' && DATE.test(parsed.from)
        ? parsed.from
        : today;
    const to =
      typeof parsed.to === 'string' && DATE.test(parsed.to) ? parsed.to : today;
    if (from > to) return empty;
    return { preset: parsed.preset as P, from, to };
  } catch {
    return empty;
  }
}

export function rememberDateFilter<P extends string>(
  key: string,
  preset: P,
  from: string,
  to: string,
): void {
  try {
    localStorage.setItem(
      `${PREFIX}${key}`,
      JSON.stringify({ preset, from, to } satisfies StoredDateFilter<P>),
    );
  } catch {
    // Storage can be disabled; the current session still keeps the choice.
  }
}
