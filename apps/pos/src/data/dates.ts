/** Business-date helpers shared by the data layer (shop time zone dates are `YYYY-MM-DD`). */

/** A real calendar date in `YYYY-MM-DD` form; rejects `2026-02-31`. */
export function isBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
}
