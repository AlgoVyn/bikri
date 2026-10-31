import { formatQtyFromMilli, type QtyUnit } from '@bikri/core';
import {
  Badge,
  Box,
  Group,
  Paper,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyText } from '../components/MoneyText.tsx';
import { ProductThumb } from '../products/ProductThumb.tsx';
import type { SellRow } from './useSell.ts';

const TILE_MIN = 128;
const GAP = 8;
const TILE_H = 172;
const TILE_H_UR = 196;
const OVERSCAN_ROWS = 3;

/** Virtualised product tiles inside the Sell scroll area (screens/05). */
export function ProductGrid({
  rows,
  highlighted,
  onAdd,
  scrollRef,
  cartQty,
}: {
  rows: readonly SellRow[];
  highlighted: number;
  onAdd: (row: SellRow) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  cartQty?: ReadonlyMap<string, number>;
}) {
  const { t } = useTranslation();
  const { i18n } = useTranslation();
  const tileH = i18n.language === 'ur' ? TILE_H_UR : TILE_H;
  const ref = useRef<HTMLUListElement>(null);
  const [view, setView] = useState({ cols: 4, start: 0, end: 8 });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the virtual window when the result set changes
  useEffect(() => {
    const scroller = scrollRef.current;
    const list = ref.current;
    if (!scroller || !list) return;
    const update = () => {
      const width = list.clientWidth;
      const cols = Math.max(1, Math.floor((width + GAP) / (TILE_MIN + GAP)));
      const offset = list.offsetTop - scroller.offsetTop;
      const top = scroller.scrollTop - offset;
      const rowH = tileH + GAP;
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
  }, [scrollRef, tileH, rows.length]);

  const totalRows = Math.ceil(rows.length / view.cols);
  const first = view.start * view.cols;
  const last = Math.min(rows.length, view.end * view.cols);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the highlight can move outside the rendered window
  useEffect(() => {
    if (highlighted < 0) return;
    const rendered = ref.current?.querySelector(
      `[data-index="${highlighted}"]`,
    );
    if (rendered) {
      rendered.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    // The highlighted tile can be outside the virtual window (keyboard navigation or a filter
    // change); scroll its row into view and let the scroll observer render it.
    const scroller = scrollRef.current;
    const list = ref.current;
    if (!scroller || !list) return;
    const row = Math.floor(highlighted / view.cols);
    const offset = list.offsetTop - scroller.offsetTop;
    const top = offset + row * (tileH + GAP);
    scroller.scrollTo({
      top: Math.max(0, top - (scroller.clientHeight - tileH) / 2),
      behavior: 'auto',
    });
  }, [highlighted, scrollRef, view.cols, tileH, rows.length]);

  return (
    <ul
      ref={ref}
      aria-label={t('sell.products')}
      className="relative"
      style={{ height: Math.max(0, totalRows * (tileH + GAP) - GAP) }}
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
              top: r * (tileH + GAP),
              insetInlineStart: `calc(${c} * (100% + ${GAP}px) / ${view.cols})`,
              width: `calc((100% - ${(view.cols - 1) * GAP}px) / ${view.cols})`,
              height: tileH,
            }}
          >
            <Tile
              row={row}
              index={index}
              active={index === highlighted}
              onAdd={onAdd}
              cartQty={cartQty?.get(row.product.id) ?? 0}
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
  cartQty,
}: {
  row: SellRow;
  index: number;
  active: boolean;
  onAdd: (row: SellRow) => void;
  cartQty: number;
}) {
  const { t, i18n } = useTranslation();
  const p = row.product;
  const name =
    i18n.language === 'ur' && p.name_ur
      ? String(p.name_ur)
      : String(p.name_en ?? '');
  const latin = !/[\u0600-\u06ff]/u.test(name);
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
                : 'bg-success-subtle text-success-subtle-ink',
          };
  return (
    <UnstyledButton
      data-index={index}
      data-testid="sell-tile"
      aria-current={active || undefined}
      h="100%"
      w="100%"
      onClick={() => onAdd(row)}
    >
      <Paper
        h="100%"
        p="sm"
        radius="lg"
        withBorder
        shadow={active ? 'md' : 'xs'}
        style={{
          borderColor: active
            ? 'var(--mantine-color-brand-6)'
            : 'var(--mantine-color-default-border)',
          boxShadow: active
            ? '0 0 0 2px var(--mantine-color-brand-2)'
            : undefined,
          transition: 'border-color 120ms ease, box-shadow 120ms ease',
        }}
      >
        <Stack gap="xs" h="100%">
          <Box pos="relative">
            <ProductThumb
              name={name}
              imageKey={p.image_key}
              color={row.category?.color}
              size="md"
            />
            {cartQty > 0 ? (
              <Badge
                circle
                color="brand"
                size="lg"
                tt="none"
                style={{ position: 'absolute', top: 0, insetInlineEnd: 0 }}
              >
                {formatQtyFromMilli(cartQty, unit)}
              </Badge>
            ) : null}
          </Box>
          <Text
            size="sm"
            fw={600}
            lineClamp={2}
            className={latin ? 'ltr-name' : undefined}
            style={{ minHeight: 36 }}
          >
            {name}
          </Text>
          <Group justify="space-between" gap={4} mt="auto" wrap="nowrap">
            <Text size="sm" fw={700}>
              <MoneyText paisa={Number(p.price ?? 0)} />
            </Text>
            {pill ? (
              <Badge
                size="sm"
                variant="filled"
                color={
                  pill.cls.includes('danger')
                    ? 'danger'
                    : pill.cls.includes('warning')
                      ? 'warning'
                      : 'success'
                }
                tt="none"
                radius="xl"
              >
                {pill.text}
              </Badge>
            ) : null}
          </Group>
        </Stack>
      </Paper>
    </UnstyledButton>
  );
}
