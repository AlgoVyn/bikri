import {
  ActionIcon,
  Badge,
  Button,
  Group,
  NativeSelect,
  Paper,
  TextInput,
} from '@mantine/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/EmptyState.tsx';
import { MoreIcon, ProductsIcon, SearchIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import {
  listCategories,
  listProducts,
  type ProductListRow,
  type ProductSort,
  productsCsv,
  type StockFilter,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { categoryName } from '../lib/category.ts';
import { downloadText } from '../lib/download.ts';
import { rememberListScroll } from '../lib/listScroll.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { marginText, qtyWithUnit } from './format.ts';
import { ProductThumb } from './ProductThumb.tsx';

const LabelsDialog = lazy(() =>
  import('../labels/LabelsDialog.tsx').then((module) => ({
    default: module.LabelsDialog,
  })),
);

const ROW_PX = 72;
const OVERSCAN = 8;

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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const activeFilters =
    (categoryId ? 1 : 0) +
    (stock !== 'all' ? 1 : 0) +
    (sort !== 'name' ? 1 : 0);
  const menuRef = useRef<HTMLDivElement>(null);
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
  const canLabel = canEdit || can('purchase.create');
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useHotkey(plainKey('n'), () => void navigate({ to: '/products/new' }), {
    enabled: canEdit,
  });

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onEscape);
    };
  }, [menuOpen]);

  return (
    <div
      className={
        embedded
          ? 'flex min-w-0 flex-col gap-3'
          : 'mx-auto flex max-w-6xl flex-col gap-3 p-4'
      }
    >
      <PageHeader
        icon={<ProductsIcon />}
        title={t('products.title')}
        subtitle={t('products.subtitle')}
        headingLevel={detailOpen ? 'h2' : 'h1'}
        actions={
          <>
            {selecting && selected.size > 0 ? (
              <Button onClick={() => setLabelsOpen(true)}>
                {t('products.print_labels', { count: selected.size })}
              </Button>
            ) : null}
            {canEdit ? (
              <Button component={Link} to="/products/new">
                {t('products.add')}
              </Button>
            ) : null}
            <div className="relative" ref={menuRef}>
              <ActionIcon
                variant="default"
                size="lg"
                aria-label={t('products.more_actions')}
                aria-expanded={menuOpen}
                aria-controls="product-actions"
                onClick={() => setMenuOpen((open) => !open)}
              >
                <MoreIcon />
              </ActionIcon>
              {menuOpen ? (
                <Paper
                  id="product-actions"
                  withBorder
                  shadow="md"
                  p={4}
                  style={{
                    position: 'absolute',
                    insetInlineEnd: 0,
                    top: 48,
                    zIndex: 30,
                    width: 224,
                  }}
                >
                  {canLabel ? (
                    <button
                      type="button"
                      className="flex min-h-11 items-center gap-2 rounded-control px-2 text-start text-small hover:bg-surface-2"
                      onClick={() => {
                        setSelecting((value) => !value);
                        setSelected(new Set());
                        setMenuOpen(false);
                      }}
                    >
                      {selecting ? t('common.cancel') : t('products.select')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={!rows || rows.length === 0}
                    className="flex min-h-11 items-center gap-2 rounded-control px-2 text-start text-small hover:bg-surface-2 disabled:bg-surface-2 disabled:text-text-muted"
                    onClick={() => {
                      if (rows)
                        downloadText(
                          'bikri-products.csv',
                          productsCsv(rows, showCost),
                        );
                      setMenuOpen(false);
                    }}
                  >
                    {t('products.export_csv')}
                  </button>
                  {canEdit ? (
                    <>
                      <Link
                        to="/products/import"
                        className="flex min-h-11 items-center gap-2 rounded-control px-2 text-small hover:bg-surface-2"
                        onClick={() => setMenuOpen(false)}
                      >
                        {t('import.button')}
                      </Link>
                      <Link
                        to="/products/prices"
                        className="flex min-h-11 items-center gap-2 rounded-control px-2 text-small hover:bg-surface-2"
                        onClick={() => setMenuOpen(false)}
                      >
                        {t('prices.button')}
                      </Link>
                      <Link
                        to="/products/categories"
                        className="flex min-h-11 items-center gap-2 rounded-control px-2 text-small hover:bg-surface-2"
                        onClick={() => setMenuOpen(false)}
                      >
                        {t('products.manage_categories')}
                      </Link>
                      <Link
                        to="/products/suggested"
                        className="flex min-h-11 items-center gap-2 rounded-control px-2 text-small hover:bg-surface-2"
                        onClick={() => setMenuOpen(false)}
                      >
                        {t('home.suggested')}
                      </Link>
                    </>
                  ) : null}
                  {can('stock.adjust') ? (
                    <Link
                      to="/stock/count"
                      className="flex min-h-11 items-center gap-2 rounded-control px-2 text-small hover:bg-surface-2"
                      onClick={() => setMenuOpen(false)}
                    >
                      {t('count.title')}
                    </Link>
                  ) : null}
                </Paper>
              ) : null}
            </div>
          </>
        }
      />

      {total === 0 ? null : (
        <Paper component="search" withBorder p="md">
          <Group align="flex-end" gap="sm" wrap="wrap">
            <TextInput
              label={t('products.search')}
              leftSection={<SearchIcon />}
              type="search"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: '2 1 14rem', minWidth: 0 }}
            />
            <Button
              variant="default"
              hiddenFrom="lg"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              {t('common.filters')}
              {activeFilters > 0 ? (
                <Badge ml={6} circle size="sm">
                  {activeFilters}
                </Badge>
              ) : null}
            </Button>
            <Group
              gap="sm"
              align="flex-end"
              wrap="wrap"
              className={filtersOpen ? 'contents' : 'hidden lg:flex'}
            >
              <NativeSelect
                label={t('products.category_filter')}
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                style={{ minWidth: 144 }}
                data={[
                  { value: '', label: t('products.all_categories') },
                  ...categories.map((c) => ({
                    value: c.id,
                    label: categoryName(c, i18n.language),
                  })),
                ]}
              />
              <NativeSelect
                label={t('products.stock_filter')}
                value={stock}
                onChange={(e) => setStock(e.target.value as StockFilter)}
                data={[
                  { value: 'all', label: t('products.stock_all') },
                  { value: 'low', label: t('products.stock_low') },
                  { value: 'out', label: t('products.stock_out') },
                  { value: 'untracked', label: t('products.stock_untracked') },
                ]}
              />
              <NativeSelect
                label={t('products.sort')}
                value={sort}
                onChange={(e) => setSort(e.target.value as ProductSort)}
                data={[
                  { value: 'name', label: t('products.sort_name') },
                  { value: 'price', label: t('products.sort_price') },
                  { value: 'stock', label: t('products.sort_stock') },
                  { value: 'best', label: t('products.sort_best') },
                ]}
              />
            </Group>
          </Group>
        </Paper>
      )}

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
          <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
            <ListHeader showCost={showCost} embedded={embedded} />
            <VirtualRows
              selectedId={selectedId}
              rows={rows}
              showCost={showCost}
              selecting={selecting}
              selected={selected}
              embedded={embedded}
              onToggle={toggle}
            />
          </div>
        </>
      ) : null}
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
  if (embedded) return 'grid-cols-[2.5rem_minmax(0,1fr)_auto]';
  return showCost
    ? 'lg:grid-cols-[2.5rem_minmax(0,3fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)]'
    : 'lg:grid-cols-[2.5rem_minmax(0,3fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)]';
};

function ListHeader({
  showCost,
  embedded,
}: {
  showCost: boolean;
  embedded: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      aria-hidden="true"
      className={`hidden gap-3 border-b border-border px-3 pb-1 text-small text-text-muted lg:grid ${gridCols(showCost, embedded)}`}
    >
      <span />
      <span>{t('products.col_name')}</span>
      {embedded ? (
        <span className="text-end">{t('products.col_price')}</span>
      ) : (
        <>
          <span>{t('products.col_category')}</span>
          <span className="text-end">{t('products.col_price')}</span>
          <span className="text-end">{t('products.col_stock')}</span>
          {showCost ? (
            <span className="text-end">{t('products.col_avg_cost')}</span>
          ) : null}
          {showCost ? (
            <span className="text-end">{t('products.col_margin')}</span>
          ) : null}
          <span className="truncate text-end" title={t('products.col_sold30')}>
            {t('products.col_sold30')}
          </span>
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
          className={`grid h-full w-full grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border px-3 text-start hover:bg-surface-2 ${gridCols(showCost, embedded)}`}
        >
          <span
            aria-hidden="true"
            className={`flex size-5 items-center justify-center rounded border ${selected ? 'border-primary bg-primary text-primary-ink' : 'border-border-strong'}`}
          >
            {selected ? '✓' : ''}
          </span>
          <span className="min-w-0">
            <span
              className={`ltr-name font-medium ${i18n.language === 'ur' ? 'line-clamp-1' : 'line-clamp-2'}`}
            >
              {String(p.name_en)}
            </span>
            <span className="block truncate text-small text-text-muted">
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
              className={`block text-small ${embedded ? '' : 'lg:hidden'} ${stockTone}`}
            >
              {row.stockState === 'untracked'
                ? t('products.not_tracked')
                : qtyWithUnit(t, row.onHand, unit)}
            </span>
          </span>
          {embedded ? null : (
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
          className={`grid h-full grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border px-3 hover:bg-surface-2 ${current ? 'bg-primary-subtle' : ''} ${gridCols(showCost, embedded)}`}
        >
          <ProductThumb
            name={String(p.name_en)}
            imageKey={p.image_key}
            color={row.category?.color}
          />
          <span className="min-w-0">
            <span
              className={`ltr-name font-medium ${i18n.language === 'ur' ? 'line-clamp-1' : 'line-clamp-2'}`}
            >
              {String(p.name_en)}
            </span>
            <span className="block truncate text-small text-text-muted">
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
              className={`block text-small ${embedded ? '' : 'lg:hidden'} ${stockTone}`}
            >
              {row.stockState === 'untracked'
                ? t('products.not_tracked')
                : qtyWithUnit(t, row.onHand, unit)}
            </span>
          </span>
          {embedded ? null : (
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
