import { formatMoney, formatQtyFromMilli, mulDivRound } from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { buttonDanger, buttonQuiet } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  ledgerContext,
  ProductInUseError,
  productDetail,
  removeProduct,
  stockHistoryCsv,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { downloadText } from '../lib/download.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { AdjustDialog } from './AdjustDialog.tsx';
import { marginText, qtyWithUnit } from './format.ts';
import { ProductThumb } from './ProductThumb.tsx';

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Karachi',
});

export function ProductDetailPage({
  id,
  adjust = false,
}: {
  id: string;
  /** `/products/:id/adjust` opens the stock adjust dialog (screens/09). */
  adjust?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const detail = useLiveQuery(() => productDetail(getDb(), id), [id]);
  const canEdit = can('catalog.edit');

  useHotkey(
    plainKey('e'),
    () => void navigate({ to: '/products/$id/edit', params: { id } }),
    {
      enabled: canEdit && Boolean(detail),
    },
  );

  if (detail === undefined) return null;
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
  const avg = Number(p.avg_cost ?? 0);
  const showCost = can('cost.view');
  const margin = marginText(price, avg);
  const maxQty = Math.max(1, ...detail.last14.map((d) => d.qty));
  const totalQty = detail.last14.reduce((s, d) => s + d.qty, 0);
  const totalRevenue = detail.last14.reduce((s, d) => s + d.revenue, 0);

  const exportHistory = () => {
    downloadText(
      `stock-history-${String(p.sku)}.csv`,
      stockHistoryCsv(
        detail.history.map((h) => ({
          at: Number(h.movement.created_at),
          reason: String(h.movement.reason_code),
          qty: formatQtyFromMilli(Number(h.movement.qty_delta_milli), unit),
          balanceAfter: formatQtyFromMilli(h.balanceAfter, unit),
          by: h.staffName,
        })),
        'Asia/Karachi',
      ),
    );
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start gap-4">
        <ProductThumb
          name={String(p.name_en)}
          imageKey={p.image_key}
          color={detail.category?.color}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <h1 className="text-h1 font-semibold break-words">
            {String(p.name_en)}
          </h1>
          {p.name_ur ? (
            <p lang="ur" dir="rtl" className="font-urdu">
              {String(p.name_ur)}
            </p>
          ) : null}
          <p className="text-text-muted">
            {[p.brand, detail.category?.name_en]
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
        <div className="flex flex-wrap gap-2">
          {canEdit ? (
            <Link
              to="/products/$id/edit"
              params={{ id }}
              className={`${buttonQuiet} gap-2`}
            >
              {t('products.edit')}
              <KeyBadge keys="E" />
            </Link>
          ) : null}
          {canEdit ? (
            <Link
              to="/products/new"
              search={{ duplicate: id }}
              className={buttonQuiet}
            >
              {t('products.duplicate')}
            </Link>
          ) : null}
          {p.track_stock === 1 && can('stock.adjust') ? (
            <Link
              to="/products/$id/adjust"
              params={{ id }}
              className={buttonQuiet}
            >
              {t('adjust.button')}
            </Link>
          ) : null}
          {can('catalog.delete') ? (
            <button
              type="button"
              className={buttonDanger}
              onClick={() => setConfirmDelete(true)}
            >
              {t('products.delete')}
            </button>
          ) : null}
        </div>
      </header>

      <section
        aria-label={t('products.price')}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <Figure label={t('products.price')} testId="detail-price">
          <MoneyText paisa={price} />
        </Figure>
        {showCost ? (
          <>
            <Figure label={t('products.avg_cost')} testId="detail-avg-cost">
              <MoneyText paisa={avg} />
            </Figure>
            <Figure label={t('products.last_cost')} testId="detail-last-cost">
              <MoneyText paisa={Number(p.last_cost ?? 0)} />
            </Figure>
            <Figure
              label={t('products.profit_per_item')}
              testId="detail-profit"
            >
              {avg > 0 ? <MoneyText paisa={price - avg} /> : '—'}
            </Figure>
            <Figure label={t('products.margin')} testId="detail-margin">
              <bdi dir="ltr">{margin ?? '—'}</bdi>
            </Figure>
          </>
        ) : null}
      </section>

      {p.track_stock === 1 ? (
        <section
          aria-label={t('products.on_hand')}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        >
          <Figure label={t('products.on_hand')} testId="detail-on-hand">
            {qtyWithUnit(t, detail.onHand, unit)}
          </Figure>
          <Figure label={t('products.min_stock')} testId="detail-min">
            {Number(p.min_stock_milli ?? 0) > 0
              ? qtyWithUnit(t, Number(p.min_stock_milli), unit)
              : '—'}
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
        </section>
      ) : null}

      <section
        aria-labelledby="last14-heading"
        className="rounded-card border border-border bg-surface p-4"
      >
        <h2 id="last14-heading" className="text-h2 font-semibold">
          {t('products.last14')}
        </h2>
        <p className="text-small text-text-muted">
          {t('products.last14_total', {
            qty: qtyWithUnit(t, totalQty, unit),
            amount: formatMoney(totalRevenue),
          })}
        </p>
        <div
          className="mt-3 flex h-24 items-end gap-1"
          dir="ltr"
          aria-hidden="true"
        >
          {detail.last14.map((d) => (
            <span
              key={d.date}
              title={`${d.date}: ${formatQtyFromMilli(d.qty, unit)}`}
              className="flex-1 rounded-t bg-primary"
              style={{
                height: `${Math.max(2, (d.qty / maxQty) * 100)}%`,
                opacity: d.qty > 0 ? 1 : 0.25,
              }}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="history-heading">
        <div className="mb-2 flex items-center gap-2">
          <h2 id="history-heading" className="me-auto text-h2 font-semibold">
            {t('products.history')}
          </h2>
          {detail.history.length > 0 ? (
            <button
              type="button"
              className={buttonQuiet}
              onClick={exportHistory}
            >
              {t('products.export_csv')}
            </button>
          ) : null}
        </div>
        {detail.history.length === 0 ? (
          <p className="text-text-muted">{t('products.history_empty')}</p>
        ) : (
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
                  <th className="px-3 py-2 text-end font-normal">
                    {t('products.history_qty')}
                  </th>
                  <th className="px-3 py-2 text-end font-normal">
                    {t('products.history_balance')}
                  </th>
                  <th className="px-3 py-2 text-start font-normal max-sm:hidden">
                    {t('products.history_by')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.history.map((h) => {
                  const delta = Number(h.movement.qty_delta_milli);
                  return (
                    <tr key={h.movement.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <bdi dir="ltr" className="text-small">
                          {timeFmt.format(Number(h.movement.created_at))}
                        </bdi>
                      </td>
                      <td className="px-3 py-2">
                        {t(`stock.reason.${String(h.movement.reason_code)}`)}
                      </td>
                      <td
                        className={`px-3 py-2 text-end ${delta < 0 ? 'text-danger' : 'text-success'}`}
                      >
                        <bdi dir="ltr">
                          {delta > 0 ? '+' : '−'}
                          {formatQtyFromMilli(Math.abs(delta), unit)}
                        </bdi>
                      </td>
                      <td
                        className="px-3 py-2 text-end"
                        data-testid="history-balance"
                      >
                        <bdi dir="ltr">
                          {formatQtyFromMilli(h.balanceAfter, unit)}
                        </bdi>
                      </td>
                      <td className="px-3 py-2 max-sm:hidden">{h.staffName}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
            else throw error;
          }
        }}
      />
      {adjust && p.track_stock === 1 && can('stock.adjust') ? (
        <AdjustDialog
          product={p}
          onHand={detail.onHand}
          open
          onClose={() => void navigate({ to: '/products/$id', params: { id } })}
        />
      ) : null}
    </div>
  );
}

function Figure({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-card border border-border bg-surface p-3"
      data-testid={testId}
    >
      <p className="text-small text-text-muted">{label}</p>
      <p className="mt-1 text-h2 font-semibold">{children}</p>
    </div>
  );
}
