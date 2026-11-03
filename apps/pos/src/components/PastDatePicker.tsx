import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addDays } from '../data/backdate.ts';
import { formatBusinessDate } from '../lib/date.ts';

const PRESETS = [
  { id: 'today', key: 'office.backdate.preset_today', days: 0 },
  { id: 'yesterday', key: 'office.backdate.preset_yesterday', days: 1 },
  { id: '7d', key: 'office.backdate.preset_7d', days: 7 },
  { id: '30d', key: 'office.backdate.preset_30d', days: 30 },
] as const;

function parts(date: string): { y: number; m: number } {
  const [y, m] = date.split('-').map(Number);
  return { y: y as number, m: m as number };
}

function iso(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function shiftMonth(
  y: number,
  m: number,
  delta: number,
): { y: number; m: number } {
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Monday = 0. */
function weekdayIndex(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * A calendar + quick presets for "Record a past sale" (D-174). Any past date is reachable:
 * the month arrows never stop going back, and only future days are disabled. The native
 * date input was hard to use on touch screens and hid the calendar behind an invisible field.
 */
export function PastDatePicker({
  value,
  today,
  onChange,
  label,
  hint,
}: {
  value: string;
  today: string;
  onChange: (date: string) => void;
  label: string;
  hint?: string;
}) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState(() => parts(value));
  useEffect(() => setView(parts(value)), [value]);
  const locale = i18n.language === 'ur' ? 'ur' : 'en';
  const todayMonth = parts(today);
  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(view.y, view.m - 1, 1))),
    [locale, view.y, view.m],
  );
  const weekdays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) =>
        new Intl.DateTimeFormat(locale, {
          weekday: 'short',
          timeZone: 'UTC',
        }).format(new Date(Date.UTC(2024, 0, 1 + i))),
      ),
    [locale],
  );
  const first = weekdayIndex(view.y, view.m, 1);
  const total = daysInMonth(view.y, view.m);
  const nextDisabled =
    view.y > todayMonth.y ||
    (view.y === todayMonth.y && view.m >= todayMonth.m);
  const presets = PRESETS.map((preset) => ({
    ...preset,
    date: addDays(today, -preset.days),
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-small">{label}</span>
        <span
          data-testid="backdate-selected-date"
          data-date={value}
          className="text-body font-semibold tabular-nums"
        >
          {formatBusinessDate(value, i18n.language)}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-testid={`backdate-preset-${preset.id}`}
            aria-pressed={value === preset.date}
            className={`min-h-9 rounded-full border px-3 text-small transition-colors ${
              value === preset.date
                ? 'border-primary bg-primary-subtle text-primary-subtle-ink'
                : 'border-border bg-surface text-text-muted hover:bg-surface-2'
            }`}
            onClick={() => onChange(preset.date)}
          >
            {t(preset.key)}
          </button>
        ))}
      </div>

      <div className="rounded-control border border-border bg-surface p-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            data-testid="backdate-prev-month"
            aria-label={t('office.backdate.prev_month')}
            className="flex size-10 items-center justify-center rounded-control text-title text-text-muted hover:bg-surface-2 rtl:rotate-180"
            onClick={() => setView(shiftMonth(view.y, view.m, -1))}
          >
            ‹
          </button>
          <span className="text-small font-medium">{monthLabel}</span>
          <button
            type="button"
            data-testid="backdate-next-month"
            aria-label={t('office.backdate.next_month')}
            disabled={nextDisabled}
            className="flex size-10 items-center justify-center rounded-control text-title text-text-muted hover:bg-surface-2 disabled:opacity-40 rtl:rotate-180"
            onClick={() => setView(shiftMonth(view.y, view.m, 1))}
          >
            ›
          </button>
        </div>
        <div
          aria-hidden="true"
          className="mt-1 grid grid-cols-7 gap-1 text-center text-small text-text-muted"
        >
          {weekdays.map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {Array.from({ length: first }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: leading calendar blanks have no identity
            <span key={`blank-${i}`} />
          ))}
          {Array.from({ length: total }, (_, i) => i + 1).map((day) => {
            const date = iso(view.y, view.m, day);
            const disabled = date > today;
            const selected = date === value;
            return (
              <button
                key={date}
                type="button"
                data-testid={`backdate-day-${date}`}
                aria-pressed={selected}
                aria-label={formatBusinessDate(date, i18n.language)}
                disabled={disabled}
                className={`flex min-h-10 items-center justify-center rounded-control text-small tabular-nums transition-colors ${
                  selected
                    ? 'bg-primary font-semibold text-primary-ink'
                    : 'text-text hover:bg-surface-2'
                } disabled:cursor-not-allowed disabled:opacity-30`}
                onClick={() => onChange(date)}
              >
                {day}
              </button>
            );
          })}
        </div>
      </div>
      {hint ? <p className="text-small text-text-muted">{hint}</p> : null}
    </div>
  );
}
