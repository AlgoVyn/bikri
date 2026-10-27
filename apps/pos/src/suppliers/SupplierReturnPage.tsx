import { formatMoney, mulDivRound, newId } from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { getKv } from '../data/kv.ts';
import type { PrinterKv } from '../data/receipt.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { queueSupplierReturnPrint } from '../data/supplierReturnReceipt.ts';
import {
  createSupplierReturn,
  SupplierReturnError,
  supplierReturnData,
} from '../data/supplierReturns.ts';
import { supplierBalance } from '../data/suppliers.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

type Unlinked = {
  key: string;
  productId: string;
  name: string;
  qtyMilli: number;
  unitCredit: number;
  trackStock: boolean;
};

const REASONS = ['faulty', 'wrong_item', 'unsold', 'expired', 'other'] as const;
const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

/** Return goods to a supplier (screens/13, 07 §10). */
export function SupplierReturnPage({
  supplierId,
  initialPurchaseId,
}: {
  supplierId: string;
  initialPurchaseId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const [purchaseId, setPurchaseId] = useState(initialPurchaseId ?? '');
  const [linkedQty, setLinkedQty] = useState<Record<string, number>>({});
  const [linkedCredit, setLinkedCredit] = useState<Record<string, number>>({});
  const [unlinked, setUnlinked] = useState<Unlinked[]>([]);
  const [query, setQuery] = useState('');
  const [reasonKey, setReasonKey] =
    useState<(typeof REASONS)[number]>('faulty');
  const [reasonText, setReasonText] = useState('');
  const [refundReceived, setRefundReceived] = useState<number | null>(null);
  const [refundTouched, setRefundTouched] = useState(false);
  const [refundMethod, setRefundMethod] = useState<'cash' | 'bank_wallet'>(
    'cash',
  );
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [returnId] = useState(() => newId());

  const data = useLiveQuery(async () => {
    const db = getDb();
    const tz = await shopTimeZone(db);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const result = await supplierReturnData(db, supplierId, today);
    if (!result) return null;
    const barcodes = await db.product_barcodes.toArray();
    const printer = await getKv<PrinterKv | null>(db, 'printer', null);
    return { ...result, today, tz, barcodes, printer };
  }, [supplierId]);

  const initializedPurchase = useRef<string | null>(null);
  useEffect(() => {
    if (!purchaseId) {
      initializedPurchase.current = null;
      return;
    }
    if (!data || initializedPurchase.current === purchaseId) return;
    const purchase = data.purchases.find(
      (row) => String(row.purchase.id) === purchaseId,
    );
    if (!purchase) return;
    initializedPurchase.current = purchaseId;
    setLinkedQty({});
    setLinkedCredit(
      Object.fromEntries(
        purchase.lines.map((line) => [
          String(line.purchaseLine.id),
          line.landedCost,
        ]),
      ),
    );
    setUnlinked([]);
  }, [purchaseId, data]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return [];
    const barcode = data.barcodes.find(
      (row) => String(row.barcode) === q && !row.deleted_at,
    );
    return data.products
      .filter(
        (product) =>
          product.id === barcode?.product_id ||
          String(product.name_en).toLowerCase().includes(q) ||
          String(product.sku).toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [query, data]);

  const purchase = data?.purchases.find(
    (row) => String(row.purchase.id) === purchaseId,
  );
  const selected = purchase
    ? purchase.lines
        .filter((line) => (linkedQty[String(line.purchaseLine.id)] ?? 0) > 0)
        .map((line) => {
          const qtyMilli = linkedQty[String(line.purchaseLine.id)] ?? 0;
          const unitCredit =
            linkedCredit[String(line.purchaseLine.id)] ?? line.landedCost;
          return {
            productId: String(line.product.id),
            purchaseLineId: String(line.purchaseLine.id),
            qtyMilli,
            unitCredit,
            lineTotal: mulDivRound(qtyMilli, unitCredit, 1000),
            name: String(line.product.name_en),
            unit: String(line.product.unit ?? 'pc'),
          };
        })
    : [];
  const allLines = [
    ...selected,
    ...unlinked.map((line) => ({
      productId: line.productId,
      purchaseLineId: null,
      qtyMilli: line.qtyMilli,
      unitCredit: line.unitCredit,
      lineTotal: mulDivRound(line.qtyMilli, line.unitCredit, 1000),
      name: line.name,
      unit: 'pc',
    })),
  ];
  const total = allLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const suggested = Math.max(0, total - Math.max(0, data?.balance ?? 0));
  useEffect(() => {
    if (!refundTouched) setRefundReceived(suggested);
  }, [suggested, refundTouched]);
  const reason =
    reasonKey === 'other'
      ? reasonText.trim()
      : t(`office.suppliers.return_reason_${reasonKey}`);
  const canSave =
    data !== null &&
    allLines.length > 0 &&
    reason.length > 0 &&
    reason.length <= 120 &&
    (refundReceived ?? 0) <= total &&
    !pending;

  const addProduct = (productId: string) => {
    const product = data?.products.find((row) => row.id === productId);
    if (!product) return;
    setUnlinked((current) => [
      ...current,
      {
        key: newId(),
        productId,
        name: String(product.name_en),
        qtyMilli: 1000,
        unitCredit: Number(product.avg_cost || product.last_cost || 0),
        trackStock: product.track_stock === 1,
      },
    ]);
    setQuery('');
  };

  const save = async () => {
    if (!data || !canSave) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      await createSupplierReturn(
        db,
        {
          returnId,
          supplierId,
          purchaseId: purchaseId || null,
          lines: allLines.map((line) => ({
            productId: line.productId,
            purchaseLineId: line.purchaseLineId,
            qtyMilli: line.qtyMilli,
            unitCredit: line.unitCredit,
          })),
          reason,
          refundReceived: refundReceived ?? 0,
          refundMethod: (refundReceived ?? 0) > 0 ? refundMethod : null,
          note,
        },
        ctx,
        { today: data.today },
      );
      if (data.printer && data.printer.auto_print !== false)
        await queueSupplierReturnPrint(db, returnId);
      const after = await supplierBalance(db, supplierId);
      toast.push(
        t('office.suppliers.return_saved', {
          count: allLines.length,
          total: formatMoney(total),
          balance: formatMoney(after),
        }),
      );
      void navigate({
        to: '/suppliers/$supplierId',
        params: { supplierId },
      });
    } catch (err) {
      toast.push(
        err instanceof SupplierReturnError
          ? t(`office.suppliers.return_error_${err.code}`)
          : t('errors.generic'),
        'error',
      );
    } finally {
      setPending(false);
    }
  };

  if (data === null)
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.suppliers.not_found')}
      </p>
    );
  if (!data) return <p className="sr-only">{t('common.loading')}</p>;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/suppliers/$supplierId"
          params={{ supplierId }}
          className={buttonQuiet}
        >
          {t('office.suppliers.back')}
        </Link>
        <h1 className="me-auto text-h1 font-semibold">
          {t('office.suppliers.return_title')}
        </h1>
        <p className="text-small text-text-muted">
          {String(data.supplier.name)} · <MoneyText paisa={data.balance} />
        </p>
      </div>

      <label className="flex flex-col gap-1 text-small">
        {t('office.suppliers.return_linked')}
        <select
          className={field}
          value={purchaseId}
          onChange={(event) => setPurchaseId(event.target.value)}
        >
          <option value="">{t('office.suppliers.return_unlinked')}</option>
          {data.purchases.map((row) => (
            <option
              key={String(row.purchase.id)}
              value={String(row.purchase.id)}
            >
              {String(row.purchase.supplier_invoice_no || row.purchase.id)} ·{' '}
              {String(row.purchase.business_date)}
            </option>
          ))}
        </select>
      </label>

      {purchase ? (
        <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
          <h2 className="text-title font-semibold">
            {t('office.suppliers.return_delivery_lines')}
          </h2>
          <table className="w-full text-small">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="p-2 text-start">
                  {t('office.suppliers.product')}
                </th>
                <th className="p-2 text-end">
                  {t('office.suppliers.received')}
                </th>
                <th className="p-2 text-end">
                  {t('office.suppliers.returned')}
                </th>
                <th className="p-2 text-start">
                  {t('office.suppliers.return_qty')}
                </th>
                {can('cost.view') ? (
                  <th className="p-2 text-start">
                    {t('office.suppliers.credit_unit')}
                  </th>
                ) : null}
                <th className="p-2 text-end">
                  {t('office.suppliers.line_total')}
                </th>
              </tr>
            </thead>
            <tbody>
              {purchase.lines.map((line) => {
                const key = String(line.purchaseLine.id);
                const qty = linkedQty[key] ?? 0;
                const credit = linkedCredit[key] ?? line.landedCost;
                return (
                  <tr
                    key={key}
                    className="border-b border-border last:border-0"
                  >
                    <td className="p-2">{String(line.product.name_en)}</td>
                    <td className="p-2 text-end">{line.received / 1000}</td>
                    <td className="p-2 text-end">{line.returned / 1000}</td>
                    <td className="w-36 p-2">
                      <QtyInput
                        label={`${t('office.suppliers.return_qty')} ${String(line.product.name_en)}`}
                        unit={String(line.product.unit ?? 'pc') as never}
                        value={qty || null}
                        onChange={(value) =>
                          setLinkedQty((current) => ({
                            ...current,
                            [key]: Math.min(value ?? 0, line.remaining),
                          }))
                        }
                      />
                      {line.remaining === 0 ? (
                        <p className="text-small text-text-muted">
                          {t('office.suppliers.return_none_left')}
                        </p>
                      ) : null}
                    </td>
                    {can('cost.view') ? (
                      <td className="w-36 p-2">
                        <MoneyInput
                          label={t('office.suppliers.credit_unit')}
                          value={credit}
                          onChange={(value) =>
                            setLinkedCredit((current) => ({
                              ...current,
                              [key]: value ?? 0,
                            }))
                          }
                        />
                      </td>
                    ) : null}
                    <td className="p-2 text-end">
                      <MoneyText paisa={mulDivRound(qty, credit, 1000)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : (
        <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
          <label className="flex flex-col gap-1 text-small">
            {t('office.suppliers.add_product')}
            <input
              className={field}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('office.suppliers.search_placeholder')}
            />
          </label>
          {matches.map((product) => (
            <button
              key={product.id}
              type="button"
              className={`${buttonQuiet} justify-start`}
              onClick={() => addProduct(product.id)}
            >
              {String(product.name_en)} · {String(product.sku)}
            </button>
          ))}
          {unlinked.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {unlinked.map((line) => (
                <li key={line.key} className="flex flex-wrap items-end gap-2">
                  <span className="min-w-32 flex-1">{line.name}</span>
                  <div className="w-32">
                    <QtyInput
                      label={`${t('office.suppliers.return_qty')} ${line.name}`}
                      unit="pc"
                      value={line.qtyMilli}
                      onChange={(value) =>
                        setUnlinked((current) =>
                          current.map((row) =>
                            row.key === line.key
                              ? { ...row, qtyMilli: value ?? 0 }
                              : row,
                          ),
                        )
                      }
                    />
                  </div>
                  {can('cost.view') ? (
                    <div className="w-36">
                      <MoneyInput
                        label={t('office.suppliers.credit_unit')}
                        value={line.unitCredit}
                        onChange={(value) =>
                          setUnlinked((current) =>
                            current.map((row) =>
                              row.key === line.key
                                ? { ...row, unitCredit: value ?? 0 }
                                : row,
                            ),
                          )
                        }
                      />
                    </div>
                  ) : null}
                  <MoneyText
                    paisa={mulDivRound(line.qtyMilli, line.unitCredit, 1000)}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-small">
          {t('office.suppliers.return_reason')}
        </legend>
        <div className="flex flex-wrap gap-1">
          {REASONS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={reasonKey === key}
              className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
              onClick={() => setReasonKey(key)}
            >
              {t(`office.suppliers.return_reason_${key}`)}
            </button>
          ))}
        </div>
        {reasonKey === 'other' ? (
          <input
            className={field}
            maxLength={120}
            value={reasonText}
            onChange={(event) => setReasonText(event.target.value)}
          />
        ) : null}
      </fieldset>

      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-card border border-border bg-surface p-3">
        <span>{t('office.suppliers.return_total')}</span>
        <span className="text-title font-semibold">
          <MoneyText paisa={total} />
        </span>
      </div>
      {suggested > 0 ? (
        <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
          <p className="text-small">
            {t('office.suppliers.return_suggested', {
              amount: formatMoney(suggested),
            })}
          </p>
          <MoneyInput
            label={t('office.suppliers.return_received')}
            value={refundReceived}
            onChange={(value) => {
              setRefundTouched(true);
              setRefundReceived(value);
            }}
          />
          <div className="flex gap-2">
            {(['cash', 'bank_wallet'] as const).map((method) => (
              <button
                key={method}
                type="button"
                aria-pressed={refundMethod === method}
                className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
                onClick={() => setRefundMethod(method)}
              >
                {t(`payment.${method}`)}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      <label className="flex flex-col gap-1 text-small">
        {t('office.suppliers.note')}
        <input
          className={field}
          maxLength={200}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonPrimary}
          disabled={!canSave}
          onClick={() => void save()}
        >
          {t('office.suppliers.return_save')}
        </button>
        <Link
          to="/suppliers/$supplierId"
          params={{ supplierId }}
          className={buttonQuiet}
        >
          {t('common.cancel')}
        </Link>
      </div>
      {refundReceived !== null && refundReceived > 0 ? (
        <p className="text-small text-text-muted">
          {t('office.suppliers.return_refund_hint')}
        </p>
      ) : null}
    </div>
  );
}
