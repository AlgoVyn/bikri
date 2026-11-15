import { formatBusinessDate, formatTimestamp } from '../lib/date.ts';

export { categoryName } from '../lib/category.ts';

export function timeText(at: number, lang: string, timeZone: string): string {
  return formatTimestamp(at, lang, timeZone, 'time');
}

export function dateText(date: string, lang: string, timeZone: string): string {
  return formatBusinessDate(date, lang, timeZone, 'weekday');
}
