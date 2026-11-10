import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  lazy,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { FilterIcon, ProductsIcon, SearchIcon } from '../components/icons.tsx';
import { ListSurface } from '../components/ListSurface.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import {
  type PageActionItem,
  PageActions,
} from '../components/PageActions.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { SortDirectionButton, SortHeader } from '../components/SortHeader.tsx';
import { searchInputClass, searchWrapperClass } from '../components/search.ts';
import {
  defaultProductSortDirection,
  filterAndSortProducts,
  listCategories,
  type ProductListRow,
  type ProductSort,
  productsCsv,
  type StockFilter,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { categoryName } from '../lib/category.ts';
import { downloadText } from '../lib/download.ts';
import { rememberListScroll } from '../lib/listScroll.ts';
import type { SortDirection } from '../lib/sort.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import {
  buildProductRows,
  useCatalogueMaster,
  useSold30,
  useStockLevels,
} from '../state/catalogue.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { marginText, qtyWithUnit } from './format.ts';
import { ProductThumb } from './ProductThumb.tsx';

const LabelsDialog = lazy(() =>
  import('../labels/LabelsDialog.tsx').then((module) => ({
    default: module.LabelsDialog,
  })),
);

const ROW_PX = 56;
const OVERSCAN = 8;

const selectClass =
  'h-11 rounded-control border border-border-strong bg-surface px-2 text-text';

/** Products list (screens/08): search, filters, sort, CSV, virtualised rows. */
export function ProductList({
  embedded = false,
  detailOpen = false,
  selectedId,
}: {
  embedded?: boolean;
  detailOpen?: boolean;
  selectedId?: string;
} = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can } = useCurrentStaff();
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [stock, setStock] = useState<StockFilter>('all');
  const [sort, setSort] = useState<ProductSort>('name');
  const [direction, setDirection] = useState<SortDirection>(
    defaultProductSortDirection('name'),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [labelsOpen, setLabelsOpen] = useState(false);
  const activeFilters =
    (categoryId ? 1 : 0) +
    (stock !== 'all' ? 1 : 0) +
    (sort !== 'name' || direction !== 'asc' ? 1 : 0);
  const deferredQuery = useDeferredValue(query);
  const master = useCatalogueMaster();
  const levels = useStockLevels();
  const sold = useSold30();
  const rows = useMemo(() => {
    if (master === undefined || levels === undefined || sold === undefined)
      return undefined;
    return filterAndSortProducts(buildProductRows(master, levels, sold), {
      query: deferredQuery,
      categoryId: categoryId || null,
      stock,
      sort,
      direction,
      language: i18n.language,
    });
  }, [
    master,
    levels,
    sold,
    deferredQuery,
    categoryId,
    stock,
    sort,
    direction,
    i18n.language,
  ]);
  const total = master?.products.length;
  const categories = useLiveQuery(() => listCategories(getDb()), []) ?? [];
  const showCost = can('cost.view');
  const canEdit = can('catalog.edit');
  const canLabel = canEdit || can('purchase.create');
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const applySort = (next: ProductSort) => {
    if (next === sort) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSort(next);
    setDirection(defaultProductSortDirection(next));
  };
  const changeSort = (next: ProductSort) => {
    setSort(next);
    setDirection(defaultProductSortDirection(next));
  };
  const toggleDirection = () =>
    setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));

  useHotkey(plainKey('n'), () => void navigate({ to: '/products/new' }), {
    enabled: canEdit,
  });

  const more: PageActionItem[] = [];
  if (canLabel) {
    more.push({
      label: selecting ? t('common.cancel') : t('products.select'),
      onSelect: () => {
        setSelecting((value) => !value);
        setSelected(new Set());
      },
    });
  }
  if (can('export.data')) {
    more.push({
      label: t('products.export_csv'),
      disabled: !rows || rows.length === 0,
      onSelect: () => {
        if (rows)
          downloadText('bikri-products.csv', productsCsv(rows, showCost));
      },
    });
  }
  if (canEdit) {
    more.push(
      { label: t('import.button'), to: '/products/import' },
      { label: t('prices.button'), to: '/products/prices' },
      {
        label: t('products.manage_categories'),
        to: '/products/categories',
      },
      { label: t('home.suggested'), to: '/products/suggested' },
    );
  }
  if (can('stock.adjust')) {
    more.push({ label: t('count.title'), to: '/stock/count' });
  }

  const primary =
    canEdit && !selecting && !detailOpen && total !== 0 ? (
      <Link to="/products/new" className={`${buttonPrimary} gap-2`}>
        {t('products.add')}
      </Link>
    ) : undefined;

  return (
    <div
      className={
        embedded ? 'flex min-w-0 flex-col gap-3' : pageClass('standard')
      }
    >
      <PageHeader
        icon={<ProductsIcon />}
        title={t('products.title')}
        subtitle={t('products.subtitle')}
        headingLevel={detailOpen ? 'h2' : 'h1'}
        hideTitleOnPhone
        actions={
          <PageActions
            primary={primary}
            more={more}
            moreLabel={t('products.more_actions')}
          />
        }
      />

      {selecting ? (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-primary/30 bg-primary-subtle px-3 py-2">
          <span className="me-auto text-small font-medium text-primary-subtle-ink">
            {t('products.selected', { count: selected.size })}
          </span>
          <button
            type="button"
            className={buttonPrimary}
            disabled={selected.size === 0}
            onClick={() => setLabelsOpen(true)}
          >
            {t('products.print_labels', { count: selected.size })}
          </button>
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => {
              setSelecting(false);
              setSelected(new Set());
            }}
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : null}

      {total === 0 ? (
        <EmptyState
          icon={<ProductsIcon />}
          message={t('products.empty')}
          actionLabel={canEdit ? t('products.add') : undefined}
          onAction={
            canEdit ? () => void navigate({ to: '/products/new' }) : undefined
          }
        />
      ) : (
        <ListSurface
          toolbar={
            <search className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-[2_1_14rem] flex-col">
                <span className="mb-1 text-small">{t('products.search')}</span>
                <span className={searchWrapperClass}>
                  <SearchIcon />
                  <input
                    type="search"
                    autoComplete="off"
                    className={searchInputClass}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </span>
              </label>
              <button
                type="button"
                className={`${buttonQuiet} relative gap-2 max-lg:size-11 max-lg:px-0 lg:hidden`}
                aria-label={
                  activeFilters > 0
                    ? `${t('common.filters')} (${activeFilters})`
                    : t('common.filters')
                }
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <FilterIcon className="size-5" />
                <span className="max-lg:sr-only">{t('common.filters')}</span>
                {activeFilters > 0 ? (
                  <span className="absolute -end-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-micro text-primary-ink lg:static lg:size-auto lg:px-1.5 lg:text-small">
                    {activeFilters}
                  </span>
                ) : null}
              </button>
              <div className={filtersOpen ? 'contents' : 'hidden lg:contents'}>
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
                        {categoryName(c, i18n.language)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-0 flex-[1_1_7rem] flex-col">
                  <span className="mb-1 text-small">
                    {t('products.stock_filter')}
                  </span>
                  <select
                    className={selectClass}
                    value={stock}
                    onChange={(e) => setStock(e.target.value as StockFilter)}
                  >
                    <option value="all">{t('products.stock_all')}</option>
                    <option value="low">{t('products.stock_low')}</option>
                    <option value="out">{t('products.stock_out')}</option>
                    <option value="untracked">
                      {t('products.stock_untracked')}
                    </option>
                  </select>
                </label>
                <div className="flex min-w-0 flex-[1_1_11rem] flex-col">
                  <span className="mb-1 text-small">{t('products.sort')}</span>
                  <div className="flex gap-1">
                    <select
                      aria-label={t('products.sort')}
                      className={`${selectClass} min-w-0 flex-1`}
                      value={sort}
                      onChange={(e) =>
                        changeSort(e.target.value as ProductSort)
                      }
                    >
                      <option value="name">{t('products.sort_name')}</option>
                      <option value="category">
                        {t('products.sort_category')}
                      </option>
                      <option value="price">{t('products.sort_price')}</option>
                      <option value="stock">{t('products.sort_stock')}</option>
                      {showCost ? (
                        <option value="cost">{t('products.sort_cost')}</option>
                      ) : null}
                      {showCost ? (
                        <option value="margin">
                          {t('products.sort_margin')}
                        </option>
                      ) : null}
                      <option value="best">{t('products.sort_best')}</option>
                    </select>
                    <SortDirectionButton
                      direction={direction}
                      onToggle={toggleDirection}
                      testId="products-sort-direction"
                    />
                  </div>
                </div>
              </div>
            </search>
          }
          summary={
            rows ? (
              <p className="text-small text-text-muted" aria-live="polite">
                {t('products.count', { count: rows.length })}
              </p>
            ) : undefined
          }
        >
          {rows && rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8">
              <p className="text-text-muted">{t('products.no_match')}</p>
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => {
                  setQuery('');
                  setCategoryId('');
                  setStock('all');
                  setSort('name');
                  setDirection(defaultProductSortDirection('name'));
                }}
              >
                {t('common.clear_filters')}
              </button>
            </div>
          ) : rows ? (
            <>
              <ListHeader
                showCost={showCost}
                embedded={embedded}
                sort={sort}
                direction={direction}
                onSort={applySort}
              />
              <VirtualRows
                selectedId={selectedId}
                rows={rows}
                showCost={showCost}
                selecting={selecting}
                selected={selected}
                embedded={embedded}
                onToggle={toggle}
              />
            </>
          ) : null}
        </ListSurface>
      )}

      {labelsOpen ? (
        <Suspense fallback={null}>
          <LabelsDialog
            open={labelsOpen}
            onOpenChange={setLabelsOpen}
            initial={[...selected].map((productId) => ({
              productId,
              copies: 1,
            }))}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

const gridCols = (showCost: boolean, embedded: boolean) => {
  if (embedded) return 'grid-cols-[2.5rem_minmax(0,1fr)_7rem_6rem]';
  return showCost
    ? 'grid-cols-[2.5rem_minmax(0,1fr)_auto] lg:grid-cols-[2.5rem_minmax(0,3fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)]'
    : 'grid-cols-[2.5rem_minmax(0,1fr)_auto] lg:grid-cols-[2.5rem_minmax(0,3fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)]';
};

function ListHeader({
  showCost,
  embedded,
  sort,
  direction,
  onSort,
}: {
  showCost: boolean;
  embedded: boolean;
  sort: ProductSort;
  direction: SortDirection;
  onSort: (sort: ProductSort) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="products-list-header"
      className={`hidden gap-3 border-s-2 border-b border-s-transparent border-border bg-surface-2 px-3 py-2 text-small text-text-muted lg:grid ${gridCols(showCost, embedded)}`}
    >
      <span />
      <SortHeader
        label={t('products.col_name')}
        active={sort === 'name'}
        direction={direction}
        onClick={() => onSort('name')}
      />
      {embedded ? (
        <>
          <SortHeader
            label={t('products.col_price')}
            active={sort === 'price'}
            direction={direction}
            onClick={() => onSort('price')}
            align="end"
          />
          <SortHeader
            label={t('products.col_stock')}
            active={sort === 'stock'}
            direction={direction}
            onClick={() => onSort('stock')}
            align="end"
          />
        </>
      ) : (
        <>
          <SortHeader
            label={t('products.col_category')}
            active={sort === 'category'}
            direction={direction}
            onClick={() => onSort('category')}
          />
          <SortHeader
            label={t('products.col_price')}
            active={sort === 'price'}
            direction={direction}
            onClick={() => onSort('price')}
            align="end"
          />
          <SortHeader
            label={t('products.col_stock')}
            active={sort === 'stock'}
            direction={direction}
            onClick={() => onSort('stock')}
            align="end"
          />
          {showCost ? (
            <SortHeader
              label={t('products.col_avg_cost')}
              active={sort === 'cost'}
              direction={direction}
              onClick={() => onSort('cost')}
              align="end"
            />
          ) : null}
          {showCost ? (
            <SortHeader
              label={t('products.col_margin')}
              active={sort === 'margin'}
              direction={direction}
              onClick={() => onSort('margin')}
              align="end"
            />
          ) : null}
          <SortHeader
            label={t('products.col_sold')}
            active={sort === 'best'}
            direction={direction}
            onClick={() => onSort('best')}
            secondLine={t('products.col_sold_days')}
            align="end"
          />
        </>
      )}
    </div>
  );
}

/** Window-scrolled virtual list: only rows near the viewport are in the DOM (5,000 products). */
function VirtualRows({
  rows,
  showCost,
  selecting,
  selected,
  embedded,
  selectedId,
  onToggle,
}: {
  rows: ProductListRow[];
  showCost: boolean;
  selecting: boolean;
  selected: ReadonlySet<string>;
  embedded: boolean;
  selectedId?: string;
  onToggle: (id: string) => void;
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
          selecting={selecting}
          selected={selected.has(row.product.id)}
          current={row.product.id === selectedId}
          embedded={embedded}
          onToggle={() => onToggle(row.product.id)}
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
  selecting,
  selected,
  current,
  embedded,
  onToggle,
}: {
  row: ProductListRow;
  showCost: boolean;
  index: number;
  setSize: number;
  selecting: boolean;
  selected: boolean;
  current: boolean;
  embedded: boolean;
  onToggle: () => void;
}) {
  const { t, i18n } = useTranslation();
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
      {selecting ? (
        <button
          type="button"
          aria-pressed={selected}
          onClick={onToggle}
          className={`grid h-full w-full items-center gap-x-3 border-s-2 border-b border-s-transparent border-border px-3 text-start transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-offset-[-2px] ${gridCols(showCost, embedded)}`}
        >
          <span
            aria-hidden="true"
            className={`flex size-5 items-center justify-center rounded border ${selected ? 'border-primary bg-primary text-primary-ink' : 'border-border-strong'}`}
          >
            {selected ? '✓' : ''}
          </span>
          <span className="min-w-0">
            <span className="ltr-name line-clamp-2 font-medium leading-tight! max-lg:text-small">
              {String(p.name_en)}
            </span>
            <span className="block truncate text-small leading-tight! text-text-muted max-lg:text-micro">
              {[p.brand, p.sku].filter(Boolean).map(String).join(' · ')}
            </span>
          </span>
          {embedded ? null : (
            <span className="hidden truncate text-text-muted lg:block">
              {categoryName(row.category, i18n.language) ||
                t('form.no_category')}
            </span>
          )}
          <span className="text-end max-lg:row-start-1 max-lg:col-start-3">
            <MoneyText paisa={Number(p.price)} />
            <span
              className={`block text-small ${embedded ? 'hidden' : 'lg:hidden'} ${stockTone}`}
            >
              {row.stockState === 'untracked'
                ? t('products.not_tracked')
                : qtyWithUnit(t, row.onHand, unit)}
            </span>
          </span>
          {embedded ? (
            <span className={`text-end ${stockTone}`}>
              {row.stockState === 'untracked'
                ? t('products.not_tracked')
                : qtyWithUnit(t, row.onHand, unit)}
            </span>
          ) : (
            <>
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
            </>
          )}
        </button>
      ) : (
        <Link
          to="/products/$id"
          params={{ id: p.id }}
          resetScroll={false}
          onClick={rememberListScroll}
          aria-current={current ? 'page' : undefined}
          className={`grid h-full focus-visible:outline-offset-[-2px] items-center gap-x-3 border-s-2 border-b border-border px-3 transition-colors duration-150 hover:bg-surface-2 ${current ? 'border-s-primary bg-primary-subtle' : 'border-s-transparent'} ${gridCols(showCost, embedded)}`}
        >
          <ProductThumb
            name={String(p.name_en)}
            imageKey={p.image_key}
            color={row.category?.color}
          />
          <span className="min-w-0">
            <span className="ltr-name line-clamp-2 font-medium leading-tight! max-lg:text-small">
              {String(p.name_en)}
            </span>
            <span className="block truncate text-small leading-tight! text-text-muted max-lg:text-micro">
              {[p.brand, p.sku].filter(Boolean).map(String).join(' · ')}
            </span>
          </span>
          {embedded ? null : (
            <span className="hidden truncate text-text-muted lg:block">
              {categoryName(row.category, i18n.language) ||
                t('form.no_category')}
            </span>
          )}
          <span className="text-end max-lg:row-start-1 max-lg:col-start-3">
            <MoneyText paisa={Number(p.price)} />
            <span
              className={`block text-small ${embedded ? 'hidden' : 'lg:hidden'} ${stockTone}`}
            >
              {row.stockState === 'untracked'
                ? t('products.not_tracked')
                : qtyWithUnit(t, row.onHand, unit)}
            </span>
          </span>
          {embedded ? (
            <span className={`text-end ${stockTone}`}>
              {row.stockState === 'untracked'
                ? t('products.not_tracked')
                : qtyWithUnit(t, row.onHand, unit)}
            </span>
          ) : (
            <>
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
            </>
          )}
        </Link>
      )}
    </li>
  );
}
