export { categoryName } from '../lib/category.ts';

const TIME = new Map<string, Intl.DateTimeFormat>();
const DATE = new Map<string, Intl.DateTimeFormat>();

function localeOf(lang: string): string {
  return lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK';
}

export function timeText(at: number, lang: string, timeZone: string): string {
  const locale = localeOf(lang);
  const key = `${locale}\u0000${timeZone}`;
  let formatter = TIME.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    });
    TIME.set(key, formatter);
  }
  return formatter.format(at);
}

export function dateText(date: string, lang: string, timeZone: string): string {
  const locale = localeOf(lang);
  const key = `${locale}\u0000${timeZone}`;
  let formatter = DATE.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone,
    });
    DATE.set(key, formatter);
  }
  return formatter.format(new Date(`${date}T12:00:00Z`));
}
