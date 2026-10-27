import { formatQtyFromMilli, type QtyUnit } from '@bikri/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyText } from '../components/MoneyText.tsx';
import { ProductThumb } from '../products/ProductThumb.tsx';
import type { SellRow } from './useSell.ts';

const TILE_MIN = 132;
const TILE_H = 176;
const GAP = 8;
const OVERSCAN_ROWS = 3;

/** Virtualised product tiles inside the Sell scroll area (screens/05). */
export function ProductGrid({
  rows,
  highlighted,
  onAdd,
  scrollRef,
}: {
  rows: readonly SellRow[];
  highlighted: number;
  onAdd: (row: SellRow) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLUListElement>(null);
  const [view, setView] = useState({ cols: 4, start: 0, end: 8 });

  useEffect(() => {
    const scroller = scrollRef.current;
    const list = ref.current;
    if (!scroller || !list) return;
    const update = () => {
      const width = list.clientWidth;
      const cols = Math.max(1, Math.floor((width + GAP) / (TILE_MIN + GAP)));
      const offset = list.offsetTop - scroller.offsetTop;
      const top = scroller.scrollTop - offset;
      const rowH = TILE_H + GAP;
      const start = Math.max(0, Math.floor(top / rowH) - OVERSCAN_ROWS);
      const end =
        Math.ceil((top + scroller.clientHeight) / rowH) + OVERSCAN_ROWS;
      setView((v) =>
        v.cols === cols && v.start === start && v.end === end
          ? v
          : { cols, start, end },
      );
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(scroller);
    observer?.observe(list);
    return () => {
      scroller.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [scrollRef]);

  const totalRows = Math.ceil(rows.length / view.cols);
  const first = view.start * view.cols;
  const last = Math.min(rows.length, view.end * view.cols);

  useEffect(() => {
    if (highlighted < 0) return;
    ref.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  return (
    <ul
      ref={ref}
      aria-label={t('sell.products')}
      className="relative"
      style={{ height: Math.max(0, totalRows * (TILE_H + GAP) - GAP) }}
    >
      {rows.slice(first, last).map((row, i) => {
        const index = first + i;
        const r = Math.floor(index / view.cols);
        const c = index % view.cols;
        return (
          <li
            key={row.product.id}
            className="absolute"
            style={{
              top: r * (TILE_H + GAP),
              insetInlineStart: `calc(${c} * (100% + ${GAP}px) / ${view.cols})`,
              width: `calc((100% - ${(view.cols - 1) * GAP}px) / ${view.cols})`,
              height: TILE_H,
            }}
          >
            <Tile
              row={row}
              index={index}
              active={index === highlighted}
              onAdd={onAdd}
            />
          </li>
        );
      })}
    </ul>
  );
}

function Tile({
  row,
  index,
  active,
  onAdd,
}: {
  row: SellRow;
  index: number;
  active: boolean;
  onAdd: (row: SellRow) => void;
}) {
  const { t } = useTranslation();
  const p = row.product;
  const name = String(p.name_en ?? '');
  const unit = String(p.unit ?? 'pc') as QtyUnit;
  const pill =
    row.stockState === 'untracked'
      ? null
      : row.stockState === 'out'
        ? {
            text: t('sell.out'),
            cls: 'bg-danger-subtle text-danger-subtle-ink',
          }
        : {
            text: t('sell.left', { qty: formatQtyFromMilli(row.onHand, unit) }),
            cls:
              row.stockState === 'low'
                ? 'bg-warning-subtle text-warning-subtle-ink'
                : 'bg-surface-2 text-text-muted',
          };
  return (
    <button
      type="button"
      data-index={index}
      data-testid="sell-tile"
      aria-current={active || undefined}
      className={`flex size-full flex-col items-start gap-1 overflow-hidden rounded-card border bg-surface p-2 text-start ${active ? 'border-primary ring-2 ring-primary' : 'border-border'}`}
      onClick={() => onAdd(row)}
    >
      <ProductThumb
        name={name}
        imageKey={p.image_key}
        color={row.category?.color}
        size="lg"
      />
      <span className="line-clamp-2 w-full text-small font-medium">{name}</span>
      <span className="mt-auto flex w-full items-center justify-between gap-1 text-small">
        <MoneyText paisa={Number(p.price ?? 0)} />
        {pill ? (
          <span
            dir="ltr"
            className={`rounded-full px-2 text-small ${pill.cls}`}
          >
            {pill.text}
          </span>
        ) : null}
      </span>
    </button>
  );
}
