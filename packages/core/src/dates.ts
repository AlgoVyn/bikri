/** `YYYY-MM-DD` in the shop's time zone (02 §1), computed on the device. */
export const DEFAULT_TIME_ZONE = 'Asia/Karachi';
const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();
const VALID_ZONES = new Set<string>();
const INVALID_ZONES = new Set<string>();

/**
 * True when `value` is an IANA time zone this runtime knows. A shop row can be edited by an
 * operator import or a restore, so a typo must be caught before it reaches a sale. Results
 * are cached: `businessDate` runs on the sell path.
 */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64)
    return false;
  if (VALID_ZONES.has(value)) return true;
  if (INVALID_ZONES.has(value)) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    if (VALID_ZONES.size < 200) VALID_ZONES.add(value);
    return true;
  } catch {
    if (INVALID_ZONES.size < 100) INVALID_ZONES.add(value);
    return false;
  }
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  // A stored typo must not make every sale fail: keep selling on the documented default.
  const zone = isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  let formatter = DATE_FORMATS.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    DATE_FORMATS.set(zone, formatter);
  }
  return formatter;
}

export function businessDate(
  now: number,
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const parts = dateFormatter(timeZone).formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
