export { categoryName } from '../lib/category.ts';

export function timeText(at: number, lang: string, timeZone: string): string {
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(at);
}

export function dateText(date: string, lang: string, timeZone: string): string {
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(new Date(`${date}T12:00:00Z`));
}
