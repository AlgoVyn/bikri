import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ProductsIcon, SearchIcon } from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import {
  listCategories,
  listProducts,
  type ProductListRow,
  type ProductSort,
  productsCsv,
  type StockFilter,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { downloadText } from '../lib/download.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { marginText, qtyWithUnit } from './format.ts';
import { tileBg } from './tiles.ts';

const ROW_PX = 72;
const OVERSCAN = 8;

const selectClass =
  'h-11 rounded-control border border-border-strong bg-surface px-2 text-text';

/** Products list (screens/08): search, filters, sort, CSV, virtualised rows. */
export function ProductList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useCurrentStaff();
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [stock, setStock] = useState<StockFilter>('all');
  const [sort, setSort] = useState<ProductSort>('name');
  const rows = useLiveQuery(
    () =>
      listProducts(getDb(), {
        query,
        categoryId: categoryId || null,
        stock,
        sort,
      }),
    [query, categoryId, stock, sort],
  );
  const total = useLiveQuery(
    () =>
      getDb()
        .products.filter((p) => !p.deleted_at)
        .count(),
    [],
  );
  const categories = useLiveQuery(() => listCategories(getDb()), []) ?? [];
  const showCost = can('cost.view');
  const canEdit = can('catalog.edit');

  useHotkey(plainKey('n'), () => void navigate({ to: '/products/new' }), {
    enabled: canEdit,
  });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-h1 font-semibold">{t('products.title')}</h1>
        {canEdit ? (
          <Link to="/products/new" className={`${buttonPrimary} gap-2`}>
            {t('products.add')}
            <KeyBadge keys="N" />
          </Link>
        ) : null}
        <button
          type="button"
          className={buttonQuiet}
          disabled={!rows || rows.length === 0}
          onClick={() =>
            rows &&
            downloadText('bikri-products.csv', productsCsv(rows, showCost))
          }
        >
          {t('products.export_csv')}
        </button>
        {canEdit ? (
          <Link to="/products/categories" className={buttonQuiet}>
            {t('products.manage_categories')}
          </Link>
        ) : null}
      </div>

      <search className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-[2_1_14rem] flex-col">
          <span className="mb-1 text-small">{t('products.search')}</span>
          <span className="flex h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-3">
            <SearchIcon />
            <input
              type="search"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-body text-text outline-none"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
        </label>
        <label className="flex min-w-0 flex-[1_1_9rem] flex-col">
          <span className="mb-1 text-small">
            {t('products.category_filter')}
          </span>
          <select
            className={selectClass}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">{t('products.all_categories')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {String(c.name_en)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-[1_1_7rem] flex-col">
          <span className="mb-1 text-small">{t('products.stock_filter')}</span>
          <select
            className={selectClass}
            value={stock}
            onChange={(e) => setStock(e.target.value as StockFilter)}
          >
            <option value="all">{t('products.stock_all')}</option>
            <option value="low">{t('products.stock_low')}</option>
            <option value="out">{t('products.stock_out')}</option>
            <option value="untracked">{t('products.stock_untracked')}</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-[1_1_8rem] flex-col">
          <span className="mb-1 text-small">{t('products.sort')}</span>
          <select
            className={selectClass}
            value={sort}
            onChange={(e) => setSort(e.target.value as ProductSort)}
          >
            <option value="name">{t('products.sort_name')}</option>
            <option value="price">{t('products.sort_price')}</option>
            <option value="stock">{t('products.sort_stock')}</option>
            <option value="best">{t('products.sort_best')}</option>
          </select>
        </label>
      </search>

      {total === 0 ? (
        <EmptyState
          icon={<ProductsIcon />}
          message={t('products.empty')}
          actionLabel={canEdit ? t('products.add') : undefined}
          onAction={
            canEdit ? () => void navigate({ to: '/products/new' }) : undefined
          }
        />
      ) : rows && rows.length === 0 ? (
        <p className="py-8 text-center text-text-muted">
          {t('products.no_match')}
        </p>
      ) : rows ? (
        <>
          <p className="text-small text-text-muted" aria-live="polite">
            {t('products.count', { count: rows.length })}
          </p>
          <ListHeader showCost={showCost} />
          <VirtualRows rows={rows} showCost={showCost} />
        </>
      ) : null}
    </div>
  );
}

const gridCols = (showCost: boolean) =>
  showCost
    ? 'lg:grid-cols-[2.5rem_minmax(0,3fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]'
    : 'lg:grid-cols-[2.5rem_minmax(0,3fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)]';

function ListHeader({ showCost }: { showCost: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      aria-hidden="true"
      className={`hidden gap-3 border-b border-border px-3 pb-1 text-small text-text-muted lg:grid ${gridCols(showCost)}`}
    >
      <span />
      <span>{t('products.col_name')}</span>
      <span>{t('products.col_category')}</span>
      <span className="text-end">{t('products.col_price')}</span>
      <span className="text-end">{t('products.col_stock')}</span>
      {showCost ? (
        <span className="text-end">{t('products.col_avg_cost')}</span>
      ) : null}
      {showCost ? (
        <span className="text-end">{t('products.col_margin')}</span>
      ) : null}
      <span className="text-end">{t('products.col_sold30')}</span>
    </div>
  );
}

/** Window-scrolled virtual list: only rows near the viewport are in the DOM (5,000 products). */
function VirtualRows({
  rows,
  showCost,
}: {
  rows: ProductListRow[];
  showCost: boolean;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLUListElement>(null);
  const [range, setRange] = useState({ start: 0, end: 40 });
  useEffect(() => {
    const update = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const start = Math.max(0, Math.floor(-top / ROW_PX) - OVERSCAN);
      const end = Math.min(
        rows.length,
        Math.ceil((window.innerHeight - top) / ROW_PX) + OVERSCAN,
      );
      setRange((r) =>
        r.start === start && r.end === end
          ? r
          : { start, end: Math.max(end, start) },
      );
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [rows.length]);
  const visible = rows.slice(range.start, range.end);
  return (
    <ul
      className="relative"
      style={{ height: rows.length * ROW_PX }}
      ref={ref}
      aria-label={t('products.title')}
    >
      {visible.map((row, i) => (
        <ProductRow
          key={row.product.id}
          row={row}
          showCost={showCost}
          index={range.start + i}
          setSize={rows.length}
        />
      ))}
    </ul>
  );
}

function ProductRow({
  row,
  showCost,
  index,
  setSize,
}: {
  row: ProductListRow;
  showCost: boolean;
  index: number;
  setSize: number;
}) {
  const { t } = useTranslation();
  const p = row.product;
  const unit = String(p.unit ?? 'pc');
  const stockTone =
    row.stockState === 'out'
      ? 'text-danger'
      : row.stockState === 'low'
        ? 'text-warning'
        : 'text-text';
  const margin = marginText(Number(p.price), Number(p.avg_cost ?? 0));
  return (
    <li
      className="absolute inset-x-0"
      style={{ top: index * ROW_PX, height: ROW_PX }}
      aria-setsize={setSize}
      aria-posinset={index + 1}
    >
      <Link
        to="/products/$id"
        params={{ id: p.id }}
        className={`grid h-full grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border px-3 hover:bg-surface-2 ${gridCols(showCost)}`}
      >
        <span
          aria-hidden="true"
          className={`flex size-10 items-center justify-center rounded-control ${tileBg(row.category?.color)} text-tile-ink font-semibold`}
        >
          {String(p.name_en).slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium">
            {String(p.name_en)}
          </span>
          <span className="block truncate text-small text-text-muted">
            {[p.brand, p.sku].filter(Boolean).map(String).join(' · ')}
          </span>
        </span>
        <span className="hidden truncate text-text-muted lg:block">
          {String(row.category?.name_en ?? '')}
        </span>
        <span className="text-end max-lg:row-start-1 max-lg:col-start-3">
          <MoneyText paisa={Number(p.price)} />
          <span className={`block text-small lg:hidden ${stockTone}`}>
            {row.stockState === 'untracked'
              ? t('products.not_tracked')
              : qtyWithUnit(t, row.onHand, unit)}
          </span>
        </span>
        <span className={`hidden text-end lg:block ${stockTone}`}>
          {row.stockState === 'untracked'
            ? t('products.not_tracked')
            : qtyWithUnit(t, row.onHand, unit)}
        </span>
        {showCost ? (
          <span className="hidden text-end lg:block">
            <MoneyText paisa={Number(p.avg_cost ?? 0)} />
          </span>
        ) : null}
        {showCost ? (
          <span className="hidden text-end lg:block">
            <bdi dir="ltr">{margin ?? '—'}</bdi>
          </span>
        ) : null}
        <span className="hidden text-end lg:block">
          {qtyWithUnit(t, row.sold30, unit)}
        </span>
      </Link>
    </li>
  );
}
