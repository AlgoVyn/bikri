import { formatMoney } from '@bikri/core';
import type { TFunction } from 'i18next';
import type { DailyPoint, PaymentMix } from '../data/reportBundle.ts';
import { shortDate } from './format.ts';

const COLORS: Record<keyof PaymentMix, string> = {
  cash: 'var(--color-primary)',
  card: 'var(--color-success)',
  bank_wallet: 'var(--color-warning)',
  udhaar: 'var(--color-danger)',
};

/** Simple responsive bars + profit line, no chart library (screens/16). */
export function DailyChart({
  points,
  showProfit,
  lang,
  t,
}: {
  points: readonly DailyPoint[];
  showProfit: boolean;
  lang: string;
  t: TFunction;
}) {
  const width = 720;
  const height = 220;
  const pad = 56;
  const values = points.flatMap((point) =>
    showProfit ? [point.sold, point.grossProfit] : [point.sold],
  );
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const allZero = values.every((value) => value === 0);
  const x = (index: number) =>
    pad +
    (points.length === 1
      ? (width - 2 * pad) / 2
      : (index / (points.length - 1)) * (width - 2 * pad));
  const y = (value: number) =>
    pad + ((max - value) / span) * (height - 2 * pad);
  const zero = y(0);
  const barWidth = Math.max(
    1,
    Math.min(18, (width - 2 * pad) / Math.max(1, points.length) - 1),
  );
  const labels = [
    points[0],
    points[Math.floor(points.length / 2)],
    points.at(-1),
  ]
    .filter((point): point is DailyPoint => point !== undefined)
    .filter(
      (point, index, list) =>
        list.findIndex((p) => p.date === point.date) === index,
    );
  const line = points
    .map((point, index) => `${x(index)},${y(point.grossProfit)}`)
    .join(' ');

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-small text-text-muted">
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block size-3 rounded-sm"
            style={{ background: 'var(--color-primary)' }}
          />
          {t('office.reports.chart_sold')}
        </span>
        {showProfit ? (
          <span className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-4"
              style={{ background: 'var(--color-success)' }}
            />
            {t('office.reports.chart_profit')}
          </span>
        ) : null}
      </div>
      {allZero ? (
        <p className="rounded-card border border-border bg-surface p-6 text-center text-small text-text-muted">
          {t('office.reports.no_data')}
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('office.reports.daily_chart')}
          className="h-52 w-full"
        >
          {[...new Set([max, min === 0 ? 0 : (max + min) / 2, min])].map(
            (value) => (
              <g key={value}>
                <line
                  x1={pad}
                  x2={width - pad}
                  y1={y(value)}
                  y2={y(value)}
                  stroke="var(--color-border)"
                  strokeWidth={value === 0 ? 1 : 0.5}
                />
                <text
                  x={4}
                  y={y(value) + 3}
                  fontSize={9}
                  fill="var(--color-text-muted)"
                >
                  {formatMoney(value)}
                </text>
              </g>
            ),
          )}
          {points.map((point, index) => {
            const top = point.sold >= 0 ? y(point.sold) : zero;
            const bottom = point.sold >= 0 ? zero : y(point.sold);
            return (
              <rect
                key={point.date}
                x={x(index) - barWidth / 2}
                y={top}
                width={barWidth}
                height={Math.max(0, bottom - top)}
                rx={1}
                fill="var(--color-primary)"
                opacity={point.date === points.at(-1)?.date ? 1 : 0.82}
              >
                <title>
                  {`${shortDate(point.date, lang)} · ${formatMoney(point.sold)}`}
                </title>
              </rect>
            );
          })}
          {showProfit ? (
            <polyline
              points={line}
              fill="none"
              stroke="var(--color-success)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <title>{t('office.reports.chart_profit')}</title>
            </polyline>
          ) : null}
          {labels.map((point) => (
            <text
              key={point.date}
              x={x(points.indexOf(point))}
              y={height - 6}
              textAnchor="middle"
              fontSize={10}
              fill="var(--color-text-muted)"
            >
              {shortDate(point.date, lang)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

/** Payment-mix donut; zero/negative segments are clamped for shape but shown in the legend. */
export function PaymentDonut({ mix, t }: { mix: PaymentMix; t: TFunction }) {
  const total = Object.values(mix).reduce(
    (sum, value) => sum + Math.max(0, value),
    0,
  );
  const methods = ['cash', 'card', 'bank_wallet', 'udhaar'] as const;
  const shown = methods.filter((method) => mix[method] !== 0);
  let offset = 0;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg
        viewBox="0 0 120 120"
        role="img"
        aria-label={t('office.reports.payment_mix')}
        className="size-28 shrink-0"
      >
        <circle
          cx="60"
          cy="60"
          r="44"
          fill="none"
          stroke="var(--color-surface-2)"
          strokeWidth="16"
        />
        {total > 0
          ? methods.map((method) => {
              const share = Math.max(0, mix[method]) / total;
              const dash = share * 100;
              const segment = (
                <circle
                  key={method}
                  cx="60"
                  cy="60"
                  r="44"
                  fill="none"
                  stroke={COLORS[method]}
                  strokeWidth="16"
                  pathLength={100}
                  strokeDasharray={`${dash} ${100 - dash}`}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 60 60)"
                />
              );
              offset += dash;
              return segment;
            })
          : null}
      </svg>
      <ul className="flex min-w-0 flex-col gap-1 text-small">
        {shown.length === 0 ? <li>—</li> : null}
        {shown.map((method) => (
          <li key={method} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block size-3 rounded-sm"
              style={{ background: COLORS[method] }}
            />
            <span className="me-auto">{t(`payment.${method}`)}</span>
            <bdi dir="ltr" className="font-mono tabular-nums">
              {formatMoney(mix[method])}
            </bdi>
          </li>
        ))}
      </ul>
    </div>
  );
}
