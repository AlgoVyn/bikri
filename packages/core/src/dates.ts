/** `YYYY-MM-DD` in the shop's time zone (02 §1), computed on the device. */
const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = DATE_FORMATS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    DATE_FORMATS.set(timeZone, formatter);
  }
  return formatter;
}

export function businessDate(now: number, timeZone = 'Asia/Karachi'): string {
  const parts = dateFormatter(timeZone).formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
