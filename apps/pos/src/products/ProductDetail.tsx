import { formatQtyFromMilli, isTimeZone, mulDivRound } from '@bikri/core';
import {
  Link,
  useLocation,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ChevronLeftIcon } from '../components/icons.tsx';
import { MoneyText, useDisplayMoney } from '../components/MoneyText.tsx';
import { PageActions } from '../components/PageActions.tsx';
import { PageLoading } from '../components/PageLoading.tsx';
import { ProductThumb } from '../components/ProductThumb.tsx';
import { usePrivacyActive } from '../components/privacy.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  addBundle,
  addProduct,
  CartFullError,
  EmptyBundleError,
  shopMoney,
} from '../data/cart.ts';
import {
  ComponentInUseError,
  componentCost,
  type HistoryRef,
  ledgerContext,
  loadBundleRecipe,
  PRODUCT_HISTORY_PAGE,
  ProductInUseError,
  productDetail,
  productStockHistory,
  removeProduct,
  stockHistoryCsv,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { useBusinessDates } from '../data/useBusinessDates.ts';
import { ReadOnlyError } from '../data/write.ts';
import { categoryName } from '../lib/category.ts';
import { formatTimestamp } from '../lib/date';
import { downloadText } from '../lib/download.ts';
import { plainKey, useHotkey } from '../lib/hotkeys.ts';
import { isLatinName, marginText, qtyWithUnit } from '../lib/productFormat.ts';
import { shortDate } from '../lib/reportFormat.ts';
import { useRecordBack } from '../peek/recordBack.ts';
import { useOpenPeek } from '../peek/usePeekNavigation.ts';
import { useSellStore } from '../sell/sellStore.ts';
import { mutateCart } from '../sell/useSell.ts';
import { useMediaQuery } from '../shell/useMediaQuery.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { AdjustDialog } from './AdjustDialog.tsx';
import { type HistoryLinkAccess, historyLinkVisible } from './historyLink.ts';

const LabelsDialog = lazy(() =>
  import('../labels/LabelsDialog.tsx').then((module) => ({
    default: module.LabelsDialog,
  })),
);

export function ProductDetailPage({
  id,
  adjust = false,
  embedded = false,
}: {
  id: string;
  /** `/products/:id/adjust` opens the stock adjust dialog (screens/09). */
  adjust?: boolean;
  embedded?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const displayMoney = useDisplayMoney();
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const recordBack = useRecordBack('/products', 'nav.products');
  const toast = useToast();
  const { staff, can, role, support, branchId } = useCurrentStaff();
  // One shop read powers the time zone, cost method and money format; the detail
  // screen used to subscribe to `shop` three times.
  const shop = useLiveQuery(() => getDb().shop.get('shop'), []);
  const timeZone = isTimeZone(shop?.timezone)
    ? String(shop?.timezone)
    : 'Asia/Karachi';
  const { today } = useBusinessDates(timeZone);
  const wide = useMediaQuery('(min-width: 640px)');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(PRODUCT_HISTORY_PAGE);
  const costMethod = shop?.cost_method === 'last' ? 'last' : 'avg';
  const detail = useLiveQuery(
    () =>
      productDetail(
        getDb(),
        id,
        Date.now(),
        historyLimit,
        costMethod,
        timeZone,
      ),
    [id, historyLimit, costMethod, timeZone],
  );
  const readOnly = useReadOnly();
  const canEdit = can('catalog.edit') && !readOnly;
  const activeCart = useSellStore((state) => state.active);
  const money = useMemo(() => shopMoney(shop), [shop]);

  useHotkey(plainKey('l'), () => setLabelsOpen(true), {
    enabled: can('catalog.edit') || can('purchase.create'),
  });

  useHotkey(
    plainKey('e'),
    () =>
      void navigate({
        to: '/products/$id/edit',
        params: { id },
        state: (previous) => ({ ...previous, bikriChild: 'product' }),
      }),
    {
      enabled: canEdit && Boolean(detail),
    },
  );

  const privacy = usePrivacyActive();

  if (detail === undefined) return <PageLoading compact />;
  if (detail === null) {
    return (
      <EmptyState
        heading={t('products.title')}
        message={t('products.not_found')}
      />
    );
  }
  const p = detail.product;
  const unit = String(p.unit ?? 'pc');
  const price = Number(p.price);
  const bundle = detail.bundle;
  const avg = bundle ? bundle.cost : Number(p.avg_cost ?? 0);
  const showCost = can('cost.view');
  const margin = marginText(price, avg);
  const minStock = Number(p.min_stock_milli ?? 0);
  const stockTone = bundle
    ? bundle.availability === null
      ? 'default'
      : bundle.availability <= 0
        ? 'danger'
        : 'default'
    : p.track_stock !== 1
      ? 'default'
      : detail.onHand <= 0
        ? 'danger'
        : minStock > 0 && detail.onHand <= minStock
          ? 'warning'
          : 'default';
  const stockLabel =
    stockTone === 'danger'
      ? t('products.stock_out')
      : stockTone === 'warning'
        ? t('products.stock_low')
        : null;
  const maxQty = Math.max(1, ...detail.last14.map((d) => d.qty));
  const totalQty = detail.last14.reduce((s, d) => s + d.qty, 0);
  const totalRevenue = detail.last14.reduce((s, d) => s + d.revenue, 0);

  const historyView = detail.history.map((h) => {
    if (h.kind === 'movement') {
      const delta = Number(h.movement.qty_delta_milli);
      const note = String(h.movement.note ?? '').trim();
      return {
        key: `movement-${String(h.movement.id)}`,
        at: Number(h.movement.created_at),
        reason: t(`stock.reason.${String(h.movement.reason_code)}`),
        note: note === '' ? null : note,
        ref: h.ref,
        qty: `${delta > 0 ? '+' : '−'}${formatQtyFromMilli(Math.abs(delta), unit)}`,
        tone: delta < 0 ? 'text-danger' : 'text-success',
        balance: formatQtyFromMilli(h.balanceAfter, unit),
        by: h.staffName,
      };
    }
    const minChanged =
      h.minStockBefore !== null &&
      h.minStockAfter !== null &&
      h.minStockBefore !== h.minStockAfter;
    const minText = minChanged
      ? t('products.track_min_change', {
          from:
            h.minStockBefore && h.minStockBefore > 0
              ? qtyWithUnit(t, h.minStockBefore, unit)
              : t('products.min_stock_off'),
          to:
            h.minStockAfter && h.minStockAfter > 0
              ? qtyWithUnit(t, h.minStockAfter, unit)
              : t('products.min_stock_off'),
        })
      : null;
    return {
      key: `tracking-${String(h.audit.id)}`,
      at: Number(h.audit.created_at),
      reason: t(
        h.trackStock === 1 ? 'stock.reason.track_on' : 'stock.reason.track_off',
      ),
      note: minText,
      ref: null,
      qty: null,
      tone: '',
      balance: formatQtyFromMilli(h.balanceAfter, unit),
      by: h.staffName,
    };
  });

  const historyAccess: HistoryLinkAccess = {
    role,
    support,
    canViewReports: can('report.view'),
    canViewCost: can('cost.view'),
    canCreatePurchase: can('purchase.create'),
    today,
    branchId,
  };

  const addToSale = async () => {
    try {
      if (bundle) {
        const db = getDb();
        const itemRows = await loadBundleRecipe(db, id);
        const components = await db.products.bulkGet(
          itemRows.map((row) => String(row.component_product_id)),
        );
        const recipe = itemRows.flatMap((row, index) => {
          const product = components[index];
          return product && !product.deleted_at
            ? [
                {
                  product,
                  qty_milli: Number(row.qty_milli),
                },
              ]
            : [];
        });
        await mutateCart(activeCart, (cart) =>
          addBundle(cart, p, recipe, 1, money.cost_method),
        );
      } else {
        await mutateCart(activeCart, (cart) =>
          addProduct(cart, p, 1000, money.cost_method),
        );
      }
      toast.push(t('pricecheck.added', { name: String(p.name_en) }), 'info');
      void navigate({ to: '/sell' });
    } catch (error) {
      if (error instanceof CartFullError)
        toast.push(t('sell.cart_full'), 'error');
      else if (error instanceof EmptyBundleError)
        toast.push(t('sell.bundle_empty'), 'error');
      else throw error;
    }
  };

  const exportHistory = async () => {
    // The screen shows one page; the CSV keeps the full movement history.
    const all = await productStockHistory(getDb(), id);
    downloadText(
      `stock-history-${String(p.sku)}.csv`,
      stockHistoryCsv(
        all.map((h) =>
          h.kind === 'movement'
            ? {
                at: Number(h.movement.created_at),
                reason: String(h.movement.reason_code),
                qty: formatQtyFromMilli(
                  Number(h.movement.qty_delta_milli),
                  unit,
                ),
                balanceAfter: formatQtyFromMilli(h.balanceAfter, unit),
                note: String(h.movement.note ?? ''),
                by: h.staffName,
              }
            : {
                at: Number(h.audit.created_at),
                reason:
                  h.trackStock === 1 ? 'track_stock_on' : 'track_stock_off',
                qty: '',
                balanceAfter: formatQtyFromMilli(h.balanceAfter, unit),
                note: '',
                by: h.staffName,
              },
        ),
        timeZone,
      ),
    );
  };

  return (
    <div
      className={
        embedded
          ? 'flex min-w-0 flex-col gap-4'
          : pageClass('standard', 'gap-4')
      }
    >
      <header className="flex flex-wrap items-start gap-3">
        {embedded && recordBack ? (
          <Link
            to="/products"
            aria-label={recordBack.label}
            title={recordBack.label}
            onClick={(event) => {
              event.preventDefault();
              recordBack.onActivate();
            }}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface text-text transition-colors duration-150 hover:bg-surface-2 active:bg-surface-2 max-lg:hidden"
          >
            <ChevronLeftIcon className="size-5 rtl:rotate-180" />
          </Link>
        ) : null}
        <ProductThumb
          name={String(p.name_en)}
          imageKey={p.image_key}
          color={detail.category?.color}
          size="header"
        />
        <div className="min-w-0 flex-1">
          <h1
            className={`data-name ${isLatinName(String(p.name_en)) ? 'ltr-name' : ''} text-h1 font-semibold break-words`}
            title={String(p.name_en)}
          >
            {String(p.name_en)}
            {bundle ? (
              <span className="ms-2 inline-block rounded-full bg-surface-2 px-2 py-0.5 align-middle text-small font-medium text-text-muted">
                {t('products.bundle_pill')}
              </span>
            ) : null}
          </h1>
          {p.name_ur ? (
            <p className="text-start font-urdu">
              <bdi lang="ur" dir="rtl">
                {String(p.name_ur)}
              </bdi>
            </p>
          ) : null}
          <p className="text-text-muted">
            {[p.brand, categoryName(detail.category, i18n.language)]
              .filter(Boolean)
              .map(String)
              .join(' · ')}
          </p>
          <dl className="mt-1 flex flex-wrap gap-x-4 text-small">
            <div className="flex gap-1">
              <dt className="text-text-muted">{t('products.sku')}</dt>
              <dd>
                <bdi dir="ltr" className="font-mono">
                  {String(p.sku)}
                </bdi>
              </dd>
            </div>
            {detail.barcodes.length > 0 ? (
              <div className="flex gap-1">
                <dt className="text-text-muted">{t('products.barcodes')}</dt>
                <dd>
                  <bdi dir="ltr" className="font-mono">
                    {detail.barcodes.map((b) => String(b.barcode)).join(', ')}
                  </bdi>
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
      </header>
      <div data-testid="product-actions">
        <PageActions
          moreLabel={t('products.more_actions')}
          primary={
            can('sale.create') && !readOnly ? (
              <button
                type="button"
                className={buttonPrimary}
                onClick={() => void addToSale()}
              >
                {t('products.sell')}
              </button>
            ) : undefined
          }
          secondary={
            <>
              {canEdit ? (
                <Link
                  to="/products/$id/edit"
                  params={{ id }}
                  state={(previous) => ({
                    ...previous,
                    bikriChild: 'product',
                  })}
                  className={`${buttonQuiet} gap-2`}
                >
                  {t('products.edit')}
                </Link>
              ) : null}
              {can('catalog.edit') || can('purchase.create') ? (
                <button
                  type="button"
                  className={`${buttonQuiet} gap-2`}
                  onClick={() => setLabelsOpen(true)}
                >
                  {t('products.print_label')}
                </button>
              ) : null}
              {p.track_stock === 1 && can('stock.adjust') && !readOnly ? (
                <Link
                  to="/products/$id/adjust"
                  params={{ id }}
                  state={(previous) => ({
                    ...previous,
                    bikriChild: 'product',
                  })}
                  className={buttonQuiet}
                >
                  {t('adjust.button')}
                </Link>
              ) : null}
            </>
          }
          more={[
            ...(canEdit
              ? [
                  {
                    label: t('products.duplicate'),
                    onSelect: () =>
                      void navigate({
                        to: '/products/new',
                        search: { duplicate: id },
                        state: (previous) => ({
                          ...previous,
                          bikriChild: 'product',
                        }),
                      }),
                  },
                ]
              : []),
            ...(can('catalog.delete') && !readOnly
              ? [
                  {
                    label: t('products.delete'),
                    tone: 'danger' as const,
                    onSelect: () => setConfirmDelete(true),
                  },
                ]
              : []),
          ]}
        />
      </div>

      <section aria-label={t('products.price')} className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Figure label={t('products.price')} testId="detail-price" emphasize>
            <MoneyText paisa={price} />
          </Figure>
          {showCost && !privacy ? (
            <Figure
              label={t('products.margin')}
              testId="detail-margin"
              emphasize
            >
              <bdi dir="ltr">{margin ?? '—'}</bdi>
            </Figure>
          ) : null}
          {bundle ? (
            <Figure
              label={t('products.available_bundles')}
              testId="detail-on-hand"
              emphasize
              tone={stockTone}
              className={showCost ? 'col-span-2 sm:col-span-1' : undefined}
            >
              {bundle.availability === null
                ? t('products.made_to_order')
                : String(bundle.availability)}
            </Figure>
          ) : p.track_stock === 1 ? (
            <Figure
              label={t('products.on_hand')}
              testId="detail-on-hand"
              emphasize
              tone={stockTone}
              className={showCost ? 'col-span-2 sm:col-span-1' : undefined}
            >
              {qtyWithUnit(t, detail.onHand, unit)}
              {stockLabel !== null ? (
                <span className="ms-2 rounded-full bg-surface/70 px-2 py-0.5 align-middle text-small font-medium">
                  {stockLabel}
                </span>
              ) : null}
            </Figure>
          ) : null}
        </div>
        {bundle ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-border bg-surface p-3 sm:grid-cols-3">
            {showCost ? (
              <Figure label={t('products.avg_cost')} testId="detail-avg-cost">
                <MoneyText paisa={bundle.cost} />
              </Figure>
            ) : null}
            <Figure
              label={t('products.items_total')}
              testId="detail-items-total"
            >
              <MoneyText paisa={bundle.itemsTotal} />
            </Figure>
            <Figure
              label={t('products.bundle_saves')}
              testId="detail-bundle-saves"
            >
              <MoneyText paisa={bundle.itemsTotal - price} />
            </Figure>
          </div>
        ) : null}
        {!bundle && (showCost || p.track_stock === 1) ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-border bg-surface p-3 sm:grid-cols-3">
            {showCost ? (
              <>
                <Figure label={t('products.avg_cost')} testId="detail-avg-cost">
                  <MoneyText paisa={avg} />
                </Figure>
                <Figure
                  label={t('products.last_cost')}
                  testId="detail-last-cost"
                >
                  <MoneyText paisa={Number(p.last_cost ?? 0)} />
                </Figure>
                <Figure
                  label={t('products.profit_per_item')}
                  testId="detail-profit"
                >
                  {avg > 0 ? <MoneyText paisa={price - avg} /> : '—'}
                </Figure>
              </>
            ) : null}
            {p.track_stock === 1 ? (
              <>
                <Figure label={t('products.min_stock')} testId="detail-min">
                  {Number(p.min_stock_milli ?? 0) > 0 ? (
                    qtyWithUnit(t, Number(p.min_stock_milli), unit)
                  ) : canEdit ? (
                    <Link
                      to="/products/$id/edit"
                      params={{ id }}
                      state={(previous) => ({
                        ...previous,
                        bikriChild: 'product',
                      })}
                      className="underline underline-offset-2"
                    >
                      {t('products.min_stock_off')}
                    </Link>
                  ) : (
                    t('products.min_stock_off')
                  )}
                </Figure>
                {showCost ? (
                  <Figure
                    label={t('products.stock_value')}
                    testId="detail-stock-value"
                  >
                    <MoneyText
                      paisa={mulDivRound(Math.max(detail.onHand, 0), avg, 1000)}
                    />
                  </Figure>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </section>

      {totalQty > 0 && !privacy ? (
        <section
          aria-labelledby="last14-heading"
          className="rounded-card border border-border bg-surface p-4"
        >
          <h2 id="last14-heading" className="text-title font-semibold">
            {t('products.last14')}
          </h2>
          {totalQty > 0 ? (
            <p className="text-small text-text-muted">
              {t('products.last14_total', {
                qty: detail.bundle
                  ? t('products.bundle_count', {
                      count: Math.round(totalQty / 1000),
                    })
                  : qtyWithUnit(t, totalQty, unit),
                amount: displayMoney(totalRevenue),
              })}
            </p>
          ) : null}
          <div className="mt-3 flex flex-col gap-1">
            <div
              className="flex h-24 items-end gap-1"
              dir="ltr"
              role="img"
              aria-label={detail.last14
                .map(
                  (d) =>
                    `${shortDate(d.date, i18n.language)}: ${formatQtyFromMilli(d.qty, unit)}`,
                )
                .join('; ')}
            >
              {detail.last14.map((d) => (
                <span
                  key={d.date}
                  title={`${shortDate(d.date, i18n.language)}: ${formatQtyFromMilli(d.qty, unit)}`}
                  className="flex-1 rounded-t bg-primary"
                  style={{
                    height: `${Math.max(2, (d.qty / maxQty) * 100)}%`,
                    opacity: d.qty > 0 ? 1 : 0.25,
                  }}
                />
              ))}
            </div>
            <div
              className="flex justify-between text-small text-text-muted"
              dir="ltr"
            >
              {[detail.last14[0], detail.last14.at(-1)]
                .filter((d): d is NonNullable<typeof d> => d !== undefined)
                .map((d) => (
                  <span key={d.date}>{shortDate(d.date, i18n.language)}</span>
                ))}
            </div>
          </div>
        </section>
      ) : null}

      {bundle ? (
        <section
          aria-labelledby="bundle-items-heading"
          className="rounded-card border border-border bg-surface p-4"
          data-testid="bundle-recipe"
        >
          <h2 id="bundle-items-heading" className="text-title font-semibold">
            {t('products.bundle_items_title')}
          </h2>
          <ul className="mt-2 flex flex-col divide-y divide-border">
            {bundle.items.map((item) => (
              <li
                key={item.product.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2"
              >
                <Link
                  to="/products/$id"
                  params={{ id: item.product.id }}
                  className={`data-name inline-flex min-h-11 min-w-0 items-center font-medium underline-offset-2 hover:underline ${isLatinName(String(item.product.name_en)) ? 'ltr-name' : ''}`}
                >
                  {String(item.product.name_en)}
                </Link>
                <span className="text-small text-text-muted">
                  {t('products.bundle_qty_per', {
                    qty: qtyWithUnit(
                      t,
                      item.qty_milli,
                      String(item.product.unit ?? 'pc'),
                    ),
                  })}
                </span>
                <span className="ms-auto text-small">
                  <MoneyText paisa={Number(item.product.price)} />
                  {showCost ? (
                    <span className="ms-2 text-text-muted">
                      <span className="me-1">{t('products.bundle_cost')}</span>
                      <MoneyText
                        paisa={componentCost(
                          item.product,
                          item.qty_milli,
                          costMethod,
                        )}
                      />
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {bundle.items.length === 0 ? (
            <p role="alert" className="mt-2 text-small text-danger">
              {t('products.bundle_empty_recipe')}
            </p>
          ) : null}
          <p className="mt-2 text-small text-text-muted">
            {t('products.bundle_stock_note')}
          </p>
        </section>
      ) : null}

      {String(p.notes ?? '').trim() !== '' ? (
        <section
          aria-labelledby="notes-heading"
          className="rounded-card border border-border bg-surface p-4"
          data-testid="product-notes"
        >
          <h2 id="notes-heading" className="text-title font-semibold">
            {t('products.notes')}
          </h2>
          <p
            dir="auto"
            className={`mt-2 whitespace-pre-wrap break-words ${
              isLatinName(String(p.notes)) ? '' : 'font-urdu'
            }`}
          >
            {String(p.notes)}
          </p>
        </section>
      ) : null}

      <section
        aria-labelledby="history-heading"
        className={bundle ? 'hidden' : undefined}
      >
        <div className="mb-2 flex items-center gap-2">
          <h2 id="history-heading" className="me-auto text-title font-semibold">
            {t('products.history')}
          </h2>
          {detail.history.length > 0 && can('export.data') ? (
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => void exportHistory()}
            >
              {t('products.export_csv')}
            </button>
          ) : null}
        </div>
        {detail.history.length === 0 ? (
          <p className="text-text-muted">{t('products.history_empty')}</p>
        ) : (
          <>
            {wide ? (
              <div className="overflow-x-auto rounded-card border border-border bg-surface">
                <table className="w-full text-start">
                  <thead className="text-small text-text-muted">
                    <tr>
                      <th className="px-3 py-2 text-start font-normal">
                        {t('products.history_when')}
                      </th>
                      <th className="px-3 py-2 text-start font-normal">
                        {t('products.history_reason')}
                      </th>
                      <th className="px-3 py-2 text-start font-normal">
                        {t('products.history_qty')}
                      </th>
                      <th className="px-3 py-2 text-start font-normal">
                        {t('products.history_balance')}
                      </th>
                      <th className="px-3 py-2 text-start font-normal">
                        {t('products.history_by')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyView.map((h) => (
                      <tr key={h.key} className="border-t border-border">
                        <td className="px-3 py-2">
                          <bdi dir="ltr" className="text-small">
                            {formatTimestamp(h.at, i18n.language, timeZone)}
                          </bdi>
                        </td>
                        <td className="px-3 py-2">
                          {h.reason}
                          {h.note ? (
                            <span className="block text-small text-text-muted">
                              {h.note}
                            </span>
                          ) : null}
                          {h.ref ? (
                            <HistoryRefLink
                              historyRef={h.ref}
                              access={historyAccess}
                              productName={String(
                                p.name_en || p.name_ur || p.sku || '',
                              )}
                            />
                          ) : null}
                        </td>
                        <td
                          className={`px-3 py-2 text-start ${h.tone}`}
                          data-testid={
                            h.qty === null ? 'history-change' : undefined
                          }
                        >
                          {h.qty === null ? (
                            <span className="text-text-muted">—</span>
                          ) : (
                            <bdi dir="ltr">{h.qty}</bdi>
                          )}
                        </td>
                        <td
                          className="px-3 py-2 text-start"
                          data-testid="history-balance"
                        >
                          <bdi dir="ltr">{h.balance}</bdi>
                        </td>
                        <td className="px-3 py-2">{h.by}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <ul className="flex flex-col rounded-card border border-border bg-surface">
                {historyView.map((h) => (
                  <li
                    key={h.key}
                    className="flex flex-col gap-1 border-b border-border p-3 last:border-0"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 font-medium">
                        {h.reason}
                        {h.note ? (
                          <span className="block text-small font-normal text-text-muted">
                            {h.note}
                          </span>
                        ) : null}
                        {h.ref ? (
                          <HistoryRefLink
                            historyRef={h.ref}
                            access={historyAccess}
                            productName={String(
                              p.name_en || p.name_ur || p.sku || '',
                            )}
                          />
                        ) : null}
                      </span>
                      <span
                        className={`shrink-0 tabular-nums ${h.tone}`}
                        data-testid={
                          h.qty === null ? 'history-change' : undefined
                        }
                      >
                        {h.qty === null ? (
                          <span className="text-text-muted">—</span>
                        ) : (
                          <bdi dir="ltr">{h.qty}</bdi>
                        )}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-small text-text-muted">
                      <bdi dir="ltr">
                        {formatTimestamp(h.at, i18n.language, timeZone)}
                      </bdi>
                      <span>
                        {t('products.history_balance')}:{' '}
                        <bdi dir="ltr" data-testid="history-balance">
                          {h.balance}
                        </bdi>
                      </span>
                      {h.by ? <span className="basis-full">{h.by}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {detail.hasMoreHistory ? (
              <button
                type="button"
                className={`${buttonQuiet} mt-3`}
                onClick={() =>
                  setHistoryLimit((limit) => limit + PRODUCT_HISTORY_PAGE)
                }
              >
                {t('products.history_more')}
              </button>
            ) : null}
          </>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('products.delete_title', { name: String(p.name_en) })}
        body={t('products.delete_body')}
        confirmLabel={t('products.delete')}
        onConfirm={async () => {
          try {
            await removeProduct(
              getDb(),
              id,
              await ledgerContext(getDb(), String(staff?.id ?? '')),
            );
            toast.push(t('products.deleted'));
            void navigate({ to: '/products' });
          } catch (error) {
            if (error instanceof ProductInUseError)
              toast.push(t('products.in_use'), 'error');
            else if (error instanceof ComponentInUseError)
              toast.push(
                t('products.component_in_use', { name: error.bundleName }),
                'error',
              );
            else
              toast.push(
                error instanceof ReadOnlyError
                  ? t('tenant.readOnly.blocked')
                  : t('errors.generic'),
                'error',
              );
          }
        }}
      />
      {labelsOpen ? (
        <Suspense fallback={null}>
          <LabelsDialog
            open={labelsOpen}
            onOpenChange={setLabelsOpen}
            initial={[{ productId: p.id, copies: 1 }]}
          />
        </Suspense>
      ) : null}
      {adjust && p.track_stock === 1 && can('stock.adjust') ? (
        <AdjustDialog
          product={p}
          onHand={detail.onHand}
          open
          onClose={() => {
            const state = location.state as unknown as
              | Record<string, unknown>
              | undefined;
            if (state?.bikriChild === 'product') {
              router.history.back();
              return;
            }
            void navigate({
              to: '/products/$id',
              params: { id },
              state: true,
              replace: true,
            });
          }}
        />
      ) : null}
    </div>
  );
}

function HistoryRefLink({
  historyRef,
  access,
  productName,
}: {
  historyRef: HistoryRef;
  access: HistoryLinkAccess;
  productName: string;
}) {
  const { t } = useTranslation();
  const openPeek = useOpenPeek();
  const isPurchase = historyRef.kind === 'purchase';
  const invoice = historyRef.invoiceNo;
  // The invoice stays LTR inside an RTL label; the wording itself follows the language.
  const label = invoice ? (
    <>
      {t(isPurchase ? 'products.history_delivery' : 'products.history_bill', {
        invoice: '',
      }).trim()}{' '}
      <bdi dir="ltr">{invoice}</bdi>
    </>
  ) : isPurchase ? (
    t('products.history_delivery_plain')
  ) : (
    t('products.history_bill_plain')
  );
  if (!historyLinkVisible(historyRef, access))
    return <span className="mt-0.5 block text-small">{label}</span>;
  const className =
    'mt-0.5 flex min-h-11 w-fit items-center gap-1 text-small font-medium text-primary underline-offset-2 hover:underline';
  return isPurchase ? (
    <Link
      to="/suppliers/$supplierId"
      params={{ supplierId: historyRef.supplierId }}
      search={{ delivery: historyRef.purchaseId }}
      className={className}
      data-testid="history-ref"
      onClick={(event) =>
        openPeek(
          event,
          { kind: 'delivery', id: historyRef.purchaseId },
          { key: 'peek.origin_product', params: { name: productName } },
        )
      }
    >
      {label}
    </Link>
  ) : (
    <Link
      to="/sales/$id"
      params={{ id: historyRef.saleId }}
      className={className}
      data-testid="history-ref"
      onClick={(event) =>
        openPeek(
          event,
          { kind: 'bill', id: historyRef.saleId },
          { key: 'peek.origin_product', params: { name: productName } },
        )
      }
    >
      {label}
    </Link>
  );
}

function Figure({
  label,
  testId,
  children,
  emphasize = false,
  tone = 'default',
  className = '',
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
  emphasize?: boolean;
  tone?: 'default' | 'warning' | 'danger';
  className?: string;
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-danger/30 bg-danger-subtle text-danger-subtle-ink'
      : tone === 'warning'
        ? 'border-warning/30 bg-warning-subtle text-warning-subtle-ink'
        : 'border-primary/20 bg-primary-subtle text-primary-subtle-ink';
  return (
    <div
      className={`${emphasize ? `rounded-card border p-3 ${toneClass}` : 'p-0'} ${className}`}
      data-testid={testId}
    >
      <p className="text-small text-text-muted">{label}</p>
      <p
        className={
          emphasize
            ? 'mt-1 text-total font-semibold'
            : 'mt-1 text-body font-semibold'
        }
      >
        {children}
      </p>
    </div>
  );
}
