/**
 * One date/time vocabulary for the till. Screens should call this instead of building their
 * own `Intl.DateTimeFormat`, so English and Urdu stay consistent and 12-hour times always use
 * an uppercase AM/PM (docs/08 §4).
 */
export type DateStyle =
  | 'date'
  | 'long'
  | 'weekday'
  | 'weekdayLong'
  | 'time'
  | 'datetime';

const LOCALE = { en: 'en-PK', ur: 'ur-PK-u-nu-latn' } as const;

export function formatTimestamp(
  value: number | Date,
  lang: string,
  timeZone = 'Asia/Karachi',
  style: DateStyle = 'datetime',
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const locale = lang === 'ur' ? LOCALE.ur : LOCALE.en;
  const options: Intl.DateTimeFormatOptions =
    style === 'time'
      ? { hour: 'numeric', minute: '2-digit' }
      : style === 'date'
        ? { day: 'numeric', month: 'short', year: 'numeric' }
        : style === 'long'
          ? { day: 'numeric', month: 'long', year: 'numeric' }
          : style === 'weekday'
            ? {
                weekday: 'short',
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              }
            : style === 'weekdayLong'
              ? { weekday: 'long', day: 'numeric', month: 'long' }
              : {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                };
  const formatted = new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone,
  }).format(date);
  return lang === 'ur'
    ? formatted
    : formatted.replace(/\b(am|pm)\b/giu, (part) => part.toUpperCase());
}

/** A `YYYY-MM-DD` business date rendered in the shop time zone (no UTC day shift). */
export function formatBusinessDate(
  iso: string,
  lang: string,
  timeZone = 'Asia/Karachi',
  style: DateStyle = 'date',
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(iso)) return iso;
  return formatTimestamp(new Date(`${iso}T12:00:00Z`), lang, timeZone, style);
}
