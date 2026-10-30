import { businessDate, computePurchase, isQtyUnit, newId } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageLoading } from '../components/PageLoading';
import { QtyInput } from '../components/QtyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { DeliveryError, saveDelivery } from '../data/purchases.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { supplierBalance } from '../data/suppliers.ts';
import { formatBusinessDate } from '../lib/date';
import { formatShopMoney } from '../lib/money';
import { useCurrentStaff } from '../state/currentStaff.ts';

type Line = {
  key: string;
  product: MasterRow;
  qtyMilli: number;
  unitCost: number;
  updatePrice: boolean;
  price: number;
};

const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

/** Record a delivery / purchase (screens/13). */
export function DeliveryPage({ supplierId }: { supplierId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [otherCharges, setOtherCharges] = useState<number | null>(null);
  const [paidNow, setPaidNow] = useState<number | null>(null);
  const [paidMethod, setPaidMethod] = useState<'cash' | 'bank_wallet' | 'card'>(
    'cash',
  );
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const purchaseId = useState(() => newId())[0];

  const data = useLiveQuery(async () => {
    const db = getDb();
    const supplier = await db.suppliers.get(supplierId);
    if (!supplier || supplier.deleted_at) return null;
    const tz = await shopTimeZone(db);
    const today = businessDate(Date.now(), tz);
    const products = (await db.products.toArray()).filter((p) => !p.deleted_at);
    const barcodes = await db.product_barcodes.toArray();
    return {
      supplier,
      tz,
      today,
      products,
      barcodes,
      balance: await supplierBalance(db, supplierId),
    };
  }, [supplierId]);

  const [date, setDate] = useState('');
  const today = data?.today ?? businessDate(Date.now());
  const chosenDate = date || today;
  const minDate = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  })();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return [];
    const barcode = data.barcodes.find(
      (b) => String(b.barcode) === q && !b.deleted_at,
    );
    return data.products
      .filter(
        (p) =>
          p.id === barcode?.product_id ||
          String(p.name_en).toLowerCase().includes(q) ||
          String(p.sku).toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [query, data]);

  const add = (product: MasterRow) => {
    setLines((current) => [
      ...current,
      {
        key: newId(),
        product,
        qtyMilli: 1000,
        unitCost: Number(product.last_cost || product.avg_cost || 0),
        updatePrice: false,
        price: Number(product.price ?? 0),
      },
    ]);
    setQuery('');
  };

  const valid = lines.filter((line) => line.qtyMilli > 0 && line.unitCost >= 0);
  const purchase =
    valid.length > 0
      ? computePurchase(
          valid.map((line) => ({
            qty_milli: line.qtyMilli,
            unit_cost: line.unitCost,
          })),
          otherCharges ?? 0,
        )
      : null;
  const total = purchase?.total ?? 0;
  const paid = paidNow ?? 0;

  const save = async () => {
    if (!data || pending || valid.length === 0) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      await saveDelivery(
        db,
        {
          purchaseId,
          supplierId,
          invoiceNo,
          date: chosenDate,
          lines: valid.map((line) => ({
            productId: line.product.id,
            qtyMilli: line.qtyMilli,
            unitCost: line.unitCost,
            updatePrice: line.updatePrice ? line.price : null,
          })),
          otherCharges: otherCharges ?? 0,
          paidNow: paid,
          paidMethod: paid > 0 ? paidMethod : null,
          note,
        },
        ctx,
        { today },
      );
      const after = await supplierBalance(db, supplierId);
      const labelRows = valid.map((line) => {
        const unit = String(line.product.unit ?? 'pc');
        const whole = ['pc', 'pair', 'set', 'box', 'pack', 'dozen'].includes(
          unit,
        );
        return {
          productId: line.product.id,
          copies: whole ? Math.max(1, Math.floor(line.qtyMilli / 1000)) : 1,
        };
      });
      sessionStorage.setItem(
        'bikri.label_seed',
        JSON.stringify({
          rows: labelRows,
          returnTo: `/suppliers/${supplierId}`,
        }),
      );
      toast.push(
        t('office.suppliers.delivery_saved', {
          count: valid.length,
          total: formatShopMoney(total),
          balance: formatShopMoney(after),
        }),
        'info',
        [
          {
            label: t('office.suppliers.print_labels'),
            onClick: () => void navigate({ to: '/labels' }),
          },
        ],
      );
      void navigate({
        to: '/suppliers/$supplierId',
        params: { supplierId },
      });
    } catch (err) {
      if (err instanceof DeliveryError)
        toast.push(t(`office.suppliers.delivery_error_${err.code}`), 'error');
      else toast.push(t('errors.generic'), 'error');
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
  if (!data) return <PageLoading compact />;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/suppliers/$supplierId"
          params={{ supplierId }}
          aria-label={t('office.suppliers.back')}
          title={t('office.suppliers.back')}
          className={`${buttonQuiet} gap-1 px-2`}
        >
          <span
            aria-hidden="true"
            className="text-title leading-none rtl:rotate-180"
          >
            ‹
          </span>
          <span>{t('common.back')}</span>
        </Link>
        <h1 className="me-auto text-h1 font-semibold">
          {t('office.suppliers.delivery_title')}
        </h1>
        <p className="text-small text-text-muted">
          {String(data.supplier.name)} · {formatShopMoney(data.balance)}
        </p>
      </div>

      <section className="grid gap-2 rounded-card border border-border bg-surface p-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-small">
          {t('office.suppliers.supplier_invoice')}
          <input
            className={field}
            maxLength={30}
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.suppliers.delivery_date')}
          <input
            type="date"
            className={field}
            min={minDate}
            max={today}
            value={chosenDate}
            onChange={(e) => setDate(e.target.value)}
          />
          <span className="text-text-muted">
            {formatBusinessDate(chosenDate, i18n.language)}
          </span>
        </label>
      </section>

      <div className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-small font-medium">
            {t('office.suppliers.lines')}
          </p>
          <p
            className="rounded-full bg-surface-2 px-2 text-small font-medium text-text"
            data-testid="delivery-line-count"
            aria-live="polite"
          >
            {t('office.suppliers.lines_count', { count: lines.length })}
          </p>
        </div>
        <search className="flex flex-col gap-1">
          <label className="flex min-w-0 flex-col">
            <span className="mb-1 text-small">
              {t('office.suppliers.add_product')}
            </span>
            <input
              className={field}
              placeholder={t('office.suppliers.search_product')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matches[0]) {
                  e.preventDefault();
                  add(matches[0]);
                }
              }}
            />
          </label>
          {matches.length > 0 ? (
            <ul className="flex flex-col rounded-control border border-border">
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-start text-small hover:bg-surface-2"
                    onClick={() => add(p)}
                  >
                    <span className="ltr-name font-medium">
                      {String(p.name_en)}
                    </span>
                    <span className="text-text-muted">{String(p.sku)}</span>
                    <span className="ms-auto">
                      <MoneyText
                        paisa={Number(p.last_cost || p.avg_cost || 0)}
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </search>

        {lines.length === 0 ? (
          <p className="text-small text-text-muted">
            {t('office.suppliers.no_lines')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lines.map((line, index) => {
              const lineResult = purchase?.lines[valid.indexOf(line)];
              const rawUnit = String(line.product.unit);
              const unit = isQtyUnit(rawUnit) ? rawUnit : 'pc';
              return (
                <li
                  key={line.key}
                  className="flex flex-wrap items-end gap-2 rounded-control border border-border p-2"
                >
                  <div className="min-w-0 flex-[2_1_12rem]">
                    <p className="truncate text-small font-medium">
                      {String(line.product.name_en)}
                    </p>
                    <p className="text-small text-text-muted">
                      {t('office.suppliers.line_total')}:{' '}
                      <MoneyText paisa={lineResult?.line_total ?? 0} />
                    </p>
                  </div>
                  <div className="w-32">
                    <QtyInput
                      label={t('office.suppliers.qty')}
                      unit={unit}
                      value={line.qtyMilli}
                      onChange={(milli) =>
                        setLines((current) =>
                          current.map((l, i) =>
                            i === index ? { ...l, qtyMilli: milli ?? 0 } : l,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="w-36">
                    <MoneyInput
                      label={t('office.suppliers.unit_cost')}
                      value={line.unitCost}
                      onChange={(paisa) =>
                        setLines((current) =>
                          current.map((l, i) =>
                            i === index ? { ...l, unitCost: paisa ?? 0 } : l,
                          ),
                        )
                      }
                    />
                  </div>
                  <label className="flex items-center gap-1 text-small">
                    <input
                      type="checkbox"
                      checked={line.updatePrice}
                      onChange={(e) =>
                        setLines((current) =>
                          current.map((l, i) =>
                            i === index
                              ? { ...l, updatePrice: e.target.checked }
                              : l,
                          ),
                        )
                      }
                    />
                    {t('office.suppliers.update_price')}
                  </label>
                  {line.updatePrice ? (
                    <div className="w-36">
                      <MoneyInput
                        label={t('office.suppliers.price')}
                        value={line.price}
                        onChange={(paisa) =>
                          setLines((current) =>
                            current.map((l, i) =>
                              i === index ? { ...l, price: paisa ?? 0 } : l,
                            ),
                          )
                        }
                      />
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() =>
                      setLines((current) =>
                        current.filter((_, i) => i !== index),
                      )
                    }
                  >
                    {t('office.suppliers.remove')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <MoneyInput
              label={t('office.suppliers.other_charges')}
              value={otherCharges}
              onChange={setOtherCharges}
            />
          </div>
          <p className="ms-auto text-small">
            {t('office.suppliers.total')}:{' '}
            <span className="text-title font-semibold">
              <MoneyText paisa={total} />
            </span>
          </p>
        </div>
      </div>

      <section className="grid gap-2 rounded-card border border-border bg-surface p-3 sm:grid-cols-2">
        <MoneyInput
          label={t('office.suppliers.paid_now')}
          value={paidNow}
          onChange={setPaidNow}
        />
        <fieldset>
          <legend className="mb-1 text-small">
            {t('office.suppliers.method')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {(['cash', 'bank_wallet', 'card'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={paidMethod === m}
                className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
                onClick={() => setPaidMethod(m)}
              >
                {t(`payment.${m}`)}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-small sm:col-span-2">
          {t('office.suppliers.note')}
          <input
            className={field}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </section>

      <div className="flex flex-wrap justify-end gap-2">
        <Link
          to="/suppliers/$supplierId"
          params={{ supplierId }}
          className={buttonQuiet}
        >
          {t('common.cancel')}
        </Link>
        <button
          type="button"
          className={buttonPrimary}
          disabled={valid.length === 0 || pending || paid > total}
          onClick={() => void save()}
        >
          {t('office.suppliers.save_delivery')}
        </button>
      </div>
      {paid > total ? (
        <p className="text-small text-danger">
          {t('office.suppliers.delivery_error_paid')}
        </p>
      ) : null}
    </div>
  );
}
