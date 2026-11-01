import type { TFunction } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { MoneyText } from '../components/MoneyText.tsx';
import type {
  DailyPoint,
  HourlyPoint,
  PaymentMix,
} from '../data/reportBundle.ts';
import { formatShopMoney } from '../lib/money';
import { shortDate } from './format.ts';

const COLORS: Record<keyof PaymentMix, string> = {
  cash: 'var(--color-primary)',
  card: 'var(--color-success)',
  bank_wallet: 'var(--color-warning)',
  udhaar: 'var(--color-brand-navy)',
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
  const svgRef = useRef<SVGSVGElement>(null);
  const [renderedWidth, setRenderedWidth] = useState(width);
  useEffect(() => {
    const element = svgRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const update = () => setRenderedWidth(element.clientWidth || width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // SVG font sizes are in viewBox units, so compensate for the rendered width: labels stay
  // around 11–12 CSS px on a phone instead of shrinking to 4 px.
  const labelFont = Math.min(
    24,
    Math.max(8, Math.round((12 * width) / Math.max(1, renderedWidth))),
  );
  const summary = points
    .map(
      (point) =>
        `${shortDate(point.date, lang)} ${formatShopMoney(point.sold)}`,
    )
    .join('; ');

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
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${t('office.reports.daily_chart')}: ${summary}`}
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
                  fontSize={labelFont}
                  fill="var(--color-text-muted)"
                >
                  {formatShopMoney(value)}
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
                  {`${shortDate(point.date, lang)} · ${formatShopMoney(point.sold)}`}
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
              fontSize={labelFont}
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

/** Payment mix as one stacked bar plus a legend with amount and share. */
export function PaymentMixBar({ mix, t }: { mix: PaymentMix; t: TFunction }) {
  const methods = ['cash', 'card', 'bank_wallet', 'udhaar'] as const;
  const total = methods.reduce(
    (sum, method) => sum + Math.max(0, mix[method]),
    0,
  );
  const shown = methods.filter((method) => mix[method] !== 0);
  const label = shown
    .map(
      (method) =>
        `${t(`payment.${method}`)} ${Math.round((Math.max(0, mix[method]) / (total || 1)) * 100)}%`,
    )
    .join(', ');
  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={`${t('office.reports.payment_mix')}: ${label}`}
        className="flex h-3 overflow-hidden rounded-full bg-surface-2"
      >
        {total > 0
          ? shown.map((method) => (
              <span
                key={method}
                className="h-full"
                style={{
                  width: `${(Math.max(0, mix[method]) / total) * 100}%`,
                  background: COLORS[method],
                }}
              />
            ))
          : null}
      </div>
      <ul className="flex flex-col gap-1.5 text-small">
        {shown.length === 0 ? <li className="text-text-muted">—</li> : null}
        {shown.map((method) => {
          const share =
            total > 0
              ? Math.round((Math.max(0, mix[method]) / total) * 100)
              : 0;
          return (
            <li key={method} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-sm"
                style={{ background: COLORS[method] }}
              />
              <span className="me-auto">{t(`payment.${method}`)}</span>
              <bdi dir="ltr" className="tabular-nums text-text-muted">
                {share}%
              </bdi>
              <span className="w-24 text-end">
                <MoneyText paisa={mix[method]} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Sales by hour for a one-day report. Bars above and below the zero line. */
export function HourlyChart({
  points,
  t,
}: {
  points: readonly HourlyPoint[];
  t: TFunction;
}) {
  const width = 720;
  const height = 180;
  const padX = 40;
  const padY = 24;
  const values = points.map((point) => point.sold);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const y = (value: number) =>
    padY + ((max - value) / span) * (height - 2 * padY);
  const zero = y(0);
  const slot = (width - 2 * padX) / 24;
  const bar = Math.max(3, slot - 6);
  const label = points
    .filter((point) => [0, 6, 12, 18, 23].includes(point.hour))
    .map((point) => `${String(point.hour).padStart(2, '0')}:00`)
    .join(' · ');
  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${t('office.reports.hourly_chart')}: ${label}`}
        className="h-40 w-full"
      >
        {[max, min].map((value) => (
          <g key={value}>
            <line
              x1={padX}
              x2={width - padX}
              y1={y(value)}
              y2={y(value)}
              stroke="var(--color-border)"
              strokeWidth={value === 0 ? 1 : 0.5}
            />
            <text
              x={4}
              y={y(value) + 3}
              fontSize={10}
              fill="var(--color-text-muted)"
            >
              {formatShopMoney(value)}
            </text>
          </g>
        ))}
        {points.map((point) => {
          const top = point.sold >= 0 ? y(point.sold) : zero;
          const bottom = point.sold >= 0 ? zero : y(point.sold);
          return (
            <rect
              key={point.hour}
              x={padX + point.hour * slot + 3}
              y={top}
              width={bar}
              height={Math.max(0, bottom - top)}
              rx={1.5}
              fill="var(--color-primary)"
              opacity={point.sold === 0 ? 0.25 : 1}
            >
              <title>
                {`${String(point.hour).padStart(2, '0')}:00 · ${formatShopMoney(point.sold)}`}
              </title>
            </rect>
          );
        })}
        {[0, 6, 12, 18, 23].map((hour) => (
          <text
            key={hour}
            x={padX + hour * slot + slot / 2}
            y={height - 4}
            textAnchor="middle"
            fontSize={10}
            fill="var(--color-text-muted)"
          >
            {String(hour).padStart(2, '0')}
          </text>
        ))}
      </svg>
    </div>
  );
}
