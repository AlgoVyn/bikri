/**
 * One date/time vocabulary for the till. Screens should call this instead of building their
 * own `Intl.DateTimeFormat`, so English and Urdu stay consistent and 12-hour times always use
 * an uppercase AM/PM (docs/08 §4).
 */
export type DateStyle =
  | 'date'
  | 'dateShort'
  | 'long'
  | 'weekday'
  | 'weekdayLong'
  | 'weekdayTime'
  | 'weekdayLongTime'
  | 'time'
  | 'datetime'
  | 'datetimeShort';

const LOCALE = { en: 'en-PK', ur: 'ur-PK-u-nu-latn' } as const;

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(
  locale: string,
  style: DateStyle,
  timeZone: string,
): Intl.DateTimeFormat {
  const key = `${locale}\u0000${style}\u0000${timeZone}`;
  const cached = FORMATTERS.get(key);
  if (cached !== undefined) return cached;
  const options: Intl.DateTimeFormatOptions =
    style === 'time'
      ? { hour: 'numeric', minute: '2-digit' }
      : style === 'date'
        ? { day: 'numeric', month: 'short', year: 'numeric' }
        : style === 'dateShort'
          ? { day: 'numeric', month: 'short' }
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
                : style === 'weekdayTime'
                  ? {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    }
                  : style === 'weekdayLongTime'
                    ? {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long',
                        hour: 'numeric',
                        minute: '2-digit',
                      }
                    : style === 'datetimeShort'
                      ? {
                          day: 'numeric',
                          month: 'short',
                          hour: 'numeric',
                          minute: '2-digit',
                        }
                      : {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        };
  const formatter = new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone,
  });
  FORMATTERS.set(key, formatter);
  return formatter;
}

export function formatTimestamp(
  value: number | Date,
  lang: string,
  timeZone = 'Asia/Karachi',
  style: DateStyle = 'datetime',
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const locale = lang === 'ur' ? LOCALE.ur : LOCALE.en;
  const formatted = formatterFor(locale, style, timeZone).format(date);
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
