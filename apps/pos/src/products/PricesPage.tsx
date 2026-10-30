import { normaliseNumericText, parseMoneyToPaisa } from '@bikri/core';
import { Navigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { ProductsIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  applyPrices,
  type PriceChange,
  type PricePreviewRow,
  pricePreview,
  ROUNDINGS,
  type Rounding,
} from '../data/bulkPrice.ts';
import { ledgerContext, listCategories } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

const fieldClass =
  'h-11 min-w-0 rounded-control border border-border-strong bg-surface px-2 text-text';
const PREVIEW_LIMIT = 200;
type Kind = PriceChange['kind'];

/** `10`, `-5`, `2.5` → basis points; null when not a number. */
export function percentToBp(raw: string): number | null {
  const text = normaliseNumericText(raw)
    .trim()
    .replace('\u2212', '-')
    .replace('%', '');
  if (!/^-?\d+(?:\.\d{1,2})?$/u.test(text)) return null;
  return Math.round(Number(text) * 100);
}

function changeOf(kind: Kind, raw: string): PriceChange | null {
  if (kind === 'percent') {
    const bp = percentToBp(raw);
    return bp === null || bp <= -10_000 ? null : { kind, bp };
  }
  const paisa = parseMoneyToPaisa(raw.replace('\u2212', '-'), {
    allowNegative: kind === 'amount',
  });
  return paisa === null ? null : { kind, paisa };
}

/** Update prices (bulk), screens/08: filter → change → rounding → preview → apply. */
export function PricesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const id = useId();
  const categories = useLiveQuery(() => listCategories(getDb()), []) ?? [];
  const [categoryId, setCategoryId] = useState('');
  const [brand, setBrand] = useState('');
  const [kind, setKind] = useState<Kind>('percent');
  const [value, setValue] = useState('');
  const [rounding, setRounding] = useState<Rounding>(0);
  const [rows, setRows] = useState<PricePreviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can('catalog.edit')) return <Navigate to="/products" replace />;

  const reset = () => setRows(null);
  const preview = async () => {
    const change = changeOf(kind, value);
    if (!change) {
      setError(t('prices.value_invalid'));
      return;
    }
    setError(null);
    setRows(
      await pricePreview(
        getDb(),
        { categoryId: categoryId || null, brand },
        change,
        rounding,
      ),
    );
  };
  const changed = rows?.filter((r) => r.next !== r.old) ?? [];
  const apply = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const ctx = await ledgerContext(getDb(), staff?.id ?? '');
      const n = await applyPrices(getDb(), rows, ctx);
      toast.push(t('prices.applied', { count: n }), 'info');
      setRows(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4">
      <SubpageHeader
        backTo="/products"
        backLabel={t('import.back_to_products')}
        icon={<ProductsIcon />}
        title={t('prices.title')}
      />
      <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${id}-cat`}>
            <span className="text-small font-medium">
              {t('products.category_filter')}
            </span>
            <select
              id={`${id}-cat`}
              className={fieldClass}
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                reset();
              }}
            >
              <option value="">{t('products.all_categories')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {String(c.name_en)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${id}-brand`}>
            <span className="text-small font-medium">{t('prices.brand')}</span>
            <input
              id={`${id}-brand`}
              className={fieldClass}
              value={brand}
              placeholder={t('prices.any_brand')}
              onChange={(e) => {
                setBrand(e.target.value);
                reset();
              }}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${id}-kind`}>
            <span className="text-small font-medium">{t('prices.change')}</span>
            <select
              id={`${id}-kind`}
              className={fieldClass}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as Kind);
                reset();
              }}
            >
              <option value="percent">{t('prices.kind_percent')}</option>
              <option value="amount">{t('prices.kind_amount')}</option>
              <option value="set">{t('prices.kind_set')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${id}-value`}>
            <span className="text-small font-medium">
              {kind === 'percent'
                ? t('prices.value_percent')
                : t('prices.value_rs')}
            </span>
            <input
              id={`${id}-value`}
              className={fieldClass}
              inputMode="decimal"
              dir="ltr"
              value={value}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setValue(e.target.value);
                reset();
              }}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${id}-round`}>
            <span className="text-small font-medium">
              {t('prices.rounding')}
            </span>
            <select
              id={`${id}-round`}
              className={fieldClass}
              value={String(rounding)}
              onChange={(e) => {
                setRounding(Number(e.target.value) as Rounding);
                reset();
              }}
            >
              {ROUNDINGS.map((r) => (
                <option key={r} value={String(r)}>
                  {r === 0
                    ? t('prices.round_none')
                    : t('prices.round_rs', { n: r / 100 })}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => void preview()}
          >
            {t('prices.preview')}
          </button>
        </div>
      </section>

      {rows ? (
        <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
          <p role="status" data-testid="prices-summary">
            {t('prices.summary', { count: changed.length, total: rows.length })}
          </p>
          <div className="overflow-x-auto rounded-card border border-border">
            <table className="w-full text-small">
              <thead className="bg-surface-2">
                <tr>
                  <th className="px-2 py-2 text-start">
                    {t('import.field.name_en')}
                  </th>
                  <th className="px-2 py-2 text-end">{t('prices.old')}</th>
                  <th className="px-2 py-2 text-end">{t('prices.new')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, PREVIEW_LIMIT).map((r) => (
                  <tr
                    key={r.product.id}
                    data-testid="price-row"
                    className="border-t border-border"
                  >
                    <td className="px-2 py-1">{String(r.product.name_en)}</td>
                    <td className="px-2 py-1 text-end">
                      <MoneyText paisa={r.old} />
                    </td>
                    <td
                      className={`px-2 py-1 text-end ${r.next !== r.old ? 'font-semibold' : ''}`}
                    >
                      <MoneyText paisa={r.next} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              className={buttonPrimary}
              disabled={busy || changed.length === 0}
              onClick={() => void apply()}
            >
              {t('prices.apply', { count: changed.length })}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
