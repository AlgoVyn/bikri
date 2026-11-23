import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from '../components/classes.ts';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageLoading } from '../components/PageLoading';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import {
  type DeliveryDetail,
  deliveryDetail as loadDeliveryDetail,
} from '../data/purchases.ts';
import { shopTimeZone } from '../data/shopTimeZone.ts';
import { qtyCsv } from '../lib/csv.ts';
import { downloadText } from '../lib/download.ts';
import { downloadBlob } from '../print/receiptImage.ts';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { dateText } from './format.ts';

export function DeliveryDetailDialog({
  purchaseId,
  open,
  onOpenChange,
}: {
  purchaseId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState(false);
  // Defence in depth for the deep link: the dialog itself never loads a delivery for a
  // profile that may not see purchase costs (screens/13, UI-H1).
  const canSeeCost = can('purchase.create') || can('cost.view');
  const canReturn = can('purchase.create') && !readOnly;
  const canLabels = can('catalog.edit') || can('purchase.create');
  const canExport = can('export.data');

  const data = useLiveQuery(async () => {
    if (!open || !purchaseId || !canSeeCost) return null;
    const db = getDb();
    const detail = await loadDeliveryDetail(db, purchaseId);
    if (!detail) return null;
    const shop = await db.shop.get('shop');
    const tz = await shopTimeZone(db);
    return {
      detail,
      tz,
      shopName: String(shop?.name ?? ''),
      shopAddress: String(shop?.address ?? ''),
      shopPhone: String(shop?.phone ?? ''),
    };
  }, [open, purchaseId, canSeeCost]);

  const close = () => onOpenChange(false);
  const detail: DeliveryDetail | null = data?.detail ?? null;
  const invoiceNo = detail
    ? String(detail.purchase.supplier_invoice_no || detail.purchase.id)
    : '';
  const paidMethod = detail?.purchase.paid_method
    ? t(`payment.${String(detail.purchase.paid_method)}`)
    : '';
  const lines = detail?.lines ?? [];
  const returns = detail?.returns ?? [];
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const canPrintLabels =
    canLabels && lines.some((line) => line.qtyMilli > line.returnedMilli);

  const fileMeta = (detail: DeliveryDetail, tz: string) => ({
    shopName: String(data?.shopName ?? ''),
    shopAddress: String(data?.shopAddress ?? ''),
    shopPhone: String(data?.shopPhone ?? ''),
    supplierName: String(detail.supplier.name),
    invoiceNo: String(
      detail.purchase.supplier_invoice_no || detail.purchase.id,
    ),
    date: dateText(String(detail.purchase.business_date), i18n.language, tz),
    lines: detail.lines.map((line) => ({
      name: line.name,
      qtyMilli: line.qtyMilli,
      unitCost: line.unitCost,
      lineTotal: line.lineTotal,
      returnedMilli: line.returnedMilli,
    })),
    otherCharges: Number(detail.purchase.other_charges),
    total: Number(detail.purchase.total),
    paidNow: Number(detail.purchase.paid_now),
    paidMethod,
    balance: detail.balance,
    note: String(detail.purchase.note ?? ''),
    returns: detail.returns.map((row) => ({
      date: dateText(String(row.business_date), i18n.language, tz),
      reason: String(row.reason ?? ''),
      total: Number(row.total),
      refundReceived: Number(row.refund_received),
    })),
    lang: i18n.language,
    labels: {
      title: t('office.suppliers.delivery_detail'),
      supplier: t('office.suppliers.statement_supplier'),
      invoice: t('office.suppliers.supplier_invoice'),
      date: t('office.suppliers.delivery_date'),
      product: t('office.suppliers.product'),
      qty: t('office.suppliers.qty'),
      returned: t('office.suppliers.returned'),
      unitCost: t('office.suppliers.unit_cost'),
      lineTotal: t('office.suppliers.line_total'),
      itemsTotal: t('office.suppliers.delivery_items_total'),
      otherCharges: t('office.suppliers.other_charges'),
      total: t('office.suppliers.total'),
      paidNow: t('office.suppliers.paid_now'),
      balanceNow: t('office.suppliers.delivery_balance_now'),
      note: t('office.suppliers.note'),
      returns: t('office.suppliers.delivery_returns'),
      returnTotal: t('office.suppliers.total'),
      refundReceived: t('office.suppliers.delivery_refund_received'),
      generatedBy: t('office.suppliers.generated_by'),
    },
  });

  const exportCsv = async () => {
    if (!data || !detail || busy) return;
    setBusy(true);
    try {
      const { deliveryDetailCsv } = await import('./deliveryFile.ts');
      downloadText(
        `delivery-${invoiceNo.replace(/[^a-z0-9-]+/giu, '-')}.csv`,
        deliveryDetailCsv(fileMeta(detail, data.tz)),
      );
    } catch {
      toast.push(t('done.share_failed'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const exportPdf = async () => {
    if (!data || !detail || busy) return;
    setBusy(true);
    try {
      downloadBlob(
        await (await import('./deliveryFile.ts')).deliveryPdf(
          fileMeta(detail, data.tz),
        ),
        `delivery-${invoiceNo.replace(/[^a-z0-9-]+/giu, '-')}.pdf`,
      );
    } catch {
      toast.push(t('done.share_failed'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    if (!data || !detail || busy) return;
    setBusy(true);
    try {
      const { deliveryPng } = await import('./deliveryFile.ts');
      const png = await deliveryPng(fileMeta(detail, data.tz));
      const file = new File(
        [png],
        `delivery-${invoiceNo.replace(/[^a-z0-9-]+/giu, '-')}.png`,
        { type: 'image/png' },
      );
      if (navigator.canShare?.({ files: [file] }))
        await navigator.share({ files: [file], title: invoiceNo });
      else {
        downloadBlob(png, file.name);
        toast.push(t('done.image_saved'));
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        toast.push(t('done.share_failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const printLabels = () => {
    if (!detail) return;
    const rows = detail.lines.flatMap((line) => {
      const remaining = Math.max(0, line.qtyMilli - line.returnedMilli);
      if (remaining <= 0) return [];
      return [
        {
          productId: String(line.line.product_id),
          copies: ['pc', 'pair', 'set', 'box', 'pack', 'dozen'].includes(
            line.unit,
          )
            ? Math.max(1, Math.floor(remaining / 1000))
            : 1,
        },
      ];
    });
    if (rows.length === 0) return;
    try {
      sessionStorage.setItem(
        'bikri.label_seed',
        JSON.stringify({
          rows,
          returnTo: `/suppliers/${String(detail.supplier.id)}`,
        }),
      );
    } catch {
      // Non-critical: the delivery detail is already saved.
    }
    close();
    void navigate({ to: '/labels' });
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={
        detail
          ? t('office.suppliers.delivery_detail_title', { invoice: invoiceNo })
          : t('office.suppliers.delivery_detail')
      }
      description={detail ? String(detail.supplier.name) : undefined}
      full
    >
      {!canSeeCost ? (
        <p
          className="p-6 text-center text-text-muted"
          data-testid="delivery-no-access"
        >
          {t('shell.no_access')}
        </p>
      ) : data === undefined ? (
        <PageLoading compact />
      ) : !data || !detail ? (
        <p className="p-6 text-center text-text-muted">
          {t('office.suppliers.delivery_not_found')}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {String(detail.supplier.phone ?? '').trim() ||
          String(detail.supplier.address ?? '').trim() ? (
            <div className="text-small text-text-muted">
              {String(detail.supplier.phone ?? '').trim() ? (
                <p dir="ltr">{String(detail.supplier.phone)}</p>
              ) : null}
              {String(detail.supplier.address ?? '').trim() ? (
                <p className="break-words">{String(detail.supplier.address)}</p>
              ) : null}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3 rounded-card bg-surface-2 p-3 sm:grid-cols-4">
            <div>
              <p className="text-small text-text-muted">
                {t('office.suppliers.delivery_date')}
              </p>
              <p className="mt-1 font-medium">
                {dateText(
                  String(detail.purchase.business_date),
                  i18n.language,
                  data.tz,
                )}
              </p>
            </div>
            <div>
              <p className="text-small text-text-muted">
                {t('office.suppliers.lines')}
              </p>
              <p className="mt-1 font-medium">{lines.length}</p>
            </div>
            <div>
              <p className="text-small text-text-muted">
                {t('office.suppliers.total')}
              </p>
              <p className="mt-1 font-semibold">
                <MoneyText paisa={Number(detail.purchase.total)} />
              </p>
            </div>
            <div>
              <p className="text-small text-text-muted">
                {t('office.suppliers.delivery_balance_now')}
              </p>
              <p className="mt-1 font-semibold">
                <MoneyText paisa={detail.balance} />
              </p>
            </div>
          </div>

          <section aria-labelledby="delivery-items-heading">
            <h3
              id="delivery-items-heading"
              className="mb-2 text-title font-semibold"
            >
              {t('office.suppliers.lines')}
            </h3>
            <ul className="divide-y divide-border rounded-card border border-border">
              {lines.map((line) => (
                <li
                  key={String(line.line.id)}
                  className="flex items-start justify-between gap-3 p-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{line.name}</p>
                    <p className="mt-0.5 text-small text-text-muted">
                      {qtyCsv(line.qtyMilli)} ×{' '}
                      <MoneyText paisa={line.unitCost} />
                      {line.returnedMilli > 0 ? (
                        <>
                          {' '}
                          · {t('office.suppliers.returned')}{' '}
                          {qtyCsv(line.returnedMilli)}
                        </>
                      ) : null}
                    </p>
                  </div>
                  <p className="shrink-0 font-semibold">
                    <MoneyText paisa={line.lineTotal} />
                  </p>
                </li>
              ))}
              {lines.length === 0 ? (
                <li className="p-4 text-center text-text-muted">
                  {t('office.suppliers.no_lines')}
                </li>
              ) : null}
            </ul>
          </section>

          <dl className="ms-auto grid w-full max-w-sm grid-cols-2 gap-x-6 gap-y-1 text-small">
            <dt className="text-text-muted">
              {t('office.suppliers.delivery_items_total')}
            </dt>
            <dd className="text-end font-medium">
              <MoneyText paisa={subtotal} />
            </dd>
            {Number(detail.purchase.other_charges) !== 0 ? (
              <>
                <dt className="text-text-muted">
                  {t('office.suppliers.other_charges')}
                </dt>
                <dd className="text-end font-medium">
                  <MoneyText paisa={Number(detail.purchase.other_charges)} />
                </dd>
              </>
            ) : null}
            <dt className="text-text-muted">{t('office.suppliers.total')}</dt>
            <dd className="text-end font-semibold">
              <MoneyText paisa={Number(detail.purchase.total)} />
            </dd>
            <dt className="text-text-muted">
              {t('office.suppliers.paid_now')}
            </dt>
            <dd className="text-end font-medium">
              <MoneyText paisa={Number(detail.purchase.paid_now)} />
              {paidMethod ? ` · ${paidMethod}` : ''}
            </dd>
          </dl>

          {String(detail.purchase.note ?? '').trim() ? (
            <p className="rounded-card bg-surface-2 p-3 text-small text-text-muted">
              <span className="font-medium text-text">
                {t('office.suppliers.note')}:
              </span>{' '}
              {String(detail.purchase.note)}
            </p>
          ) : null}

          {returns.length > 0 ? (
            <section aria-labelledby="delivery-returns-heading">
              <h3
                id="delivery-returns-heading"
                className="mb-2 text-title font-semibold"
              >
                {t('office.suppliers.delivery_returns')}
              </h3>
              <ul className="divide-y divide-border rounded-card border border-border text-small">
                {returns.map((row) => (
                  <li
                    key={String(row.id)}
                    className="flex flex-wrap items-center justify-between gap-2 p-3"
                  >
                    <span>
                      {dateText(
                        String(row.business_date),
                        i18n.language,
                        data.tz,
                      )}{' '}
                      · {String(row.reason ?? '')}
                    </span>
                    <span className="flex flex-wrap gap-3 text-text-muted">
                      <span>
                        {t('office.suppliers.total')}:{' '}
                        <MoneyText paisa={Number(row.total)} />
                      </span>
                      <span>
                        {t('office.suppliers.delivery_refund_received')}:{' '}
                        <MoneyText paisa={Number(row.refund_received)} />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
            {canReturn ? (
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => {
                  close();
                  void navigate({
                    to: '/suppliers/$supplierId/return/new',
                    params: { supplierId: String(detail.supplier.id) },
                    search: { purchase: String(detail.purchase.id) },
                  });
                }}
              >
                {t('office.suppliers.return_items')}
              </button>
            ) : null}
            {canPrintLabels ? (
              <button
                type="button"
                className={buttonQuiet}
                onClick={printLabels}
              >
                {t('office.suppliers.print_labels')}
              </button>
            ) : null}
            {canExport ? (
              <ExportMenu
                onCsv={() => void exportCsv()}
                onPdf={() => void exportPdf()}
                onShare={() => void share()}
              />
            ) : null}
            <button type="button" className={buttonQuiet} onClick={close}>
              {t('common.close')}
            </button>
          </div>
          {busy ? (
            <p
              className="text-end text-small text-text-muted"
              aria-live="polite"
            >
              {t('office.suppliers.exporting')}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
