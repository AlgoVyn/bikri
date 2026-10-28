import { formatQtyFromMilli, type QtyUnit } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import { Link, Navigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { QtyInput } from '../components/QtyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { findByCode } from '../data/cart.ts';
import { ledgerContext, listCategories } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import {
  type CountDraft,
  type CountScope,
  discardCount,
  finishCount,
  loadCountDraft,
  startCount,
  updateCount,
} from '../data/stock.ts';
import { beep } from '../sell/beep.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

/** Stock count (screens/09): scope → counted list → Finish count. */
export function StockCountPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const draft = useLiveQuery(() => loadCountDraft(getDb()), []);
  const products = useLiveQuery(async () => {
    const d = await loadCountDraft(getDb());
    if (!d) return [] as MasterRow[];
    const rows = await getDb().products.bulkGet(Object.keys(d.expected));
    return rows
      .filter((p): p is MasterRow => Boolean(p))
      .sort((a, b) => String(a.name_en).localeCompare(String(b.name_en)));
  }, [draft?.started_at]);
  const categories = useLiveQuery(() => listCategories(getDb()), []);
  const [scopeKind, setScopeKind] = useState<CountScope['kind']>('all');
  const [categoryId, setCategoryId] = useState('');
  const [zero, setZero] = useState(false);
  const [scan, setScan] = useState('');
  const scanId = useId();

  if (!can('stock.adjust')) return <Navigate to="/" replace />;
  if (draft === undefined) return null;

  const setCounted = async (
    _d: CountDraft,
    id: string,
    milli: number | null,
  ) => {
    await updateCount(getDb(), id, () => milli);
  };

  if (!draft) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="me-auto text-h1 font-semibold">{t('count.title')}</h1>
          <Link to="/products" className={buttonQuiet}>
            {t('import.back_to_products')}
          </Link>
        </div>
        <section className="flex flex-col gap-4 rounded-card border border-border bg-surface p-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium">{t('count.scope')}</legend>
            {(['all', 'category', 'low'] as const).map((k) => (
              <label key={k} className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="scope"
                  checked={scopeKind === k}
                  onChange={() => setScopeKind(k)}
                />
                {t(`count.scope_${k}`)}
              </label>
            ))}
          </fieldset>
          {scopeKind === 'category' ? (
            <label className="flex flex-col gap-1">
              <span className="text-small font-medium">
                {t('count.category')}
              </span>
              <select
                className="h-11 rounded-control border border-border-strong bg-surface px-2"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">—</option>
                {categories?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {String(c.name_en)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className={`${buttonPrimary} self-start`}
            disabled={scopeKind === 'category' && !categoryId}
            onClick={() =>
              void startCount(
                getDb(),
                scopeKind === 'category'
                  ? { kind: 'category', categoryId }
                  : { kind: scopeKind },
              )
            }
          >
            {t('count.start')}
          </button>
        </section>
      </div>
    );
  }

  const counted = Object.keys(draft.counted).length;
  const finish = async () => {
    const ctx = await ledgerContext(getDb(), staff?.id ?? '');
    const r = await finishCount(getDb(), draft, { zeroUncounted: zero }, ctx);
    toast.push(t('count.finished', { count: r.movements }), 'info');
  };
  const onScan = async (code: string) => {
    const product = await findByCode(getDb(), code.trim());
    if (!product || !(product.id in draft.expected)) {
      toast.push(t('count.not_in_count', { code }), 'error');
      return;
    }
    beep();
    await updateCount(getDb(), product.id, (current) => (current ?? 0) + 1000);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-h1 font-semibold">{t('count.title')}</h1>
      <p className="text-text-muted" data-testid="count-progress">
        {t('count.progress', {
          counted,
          total: Object.keys(draft.expected).length,
        })}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (scan.trim()) void onScan(scan);
          setScan('');
        }}
      >
        <label htmlFor={scanId} className="text-small font-medium">
          {t('count.scan')}
        </label>
        <input
          id={scanId}
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-3 font-mono"
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          autoComplete="off"
        />
      </form>
      <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
        {products?.map((p) => {
          const unit = String(p.unit ?? 'pc') as QtyUnit;
          const expected = draft.expected[p.id] ?? 0;
          const value = Object.hasOwn(draft.counted, p.id)
            ? (draft.counted[p.id] ?? 0)
            : null;
          const diff = value === null ? null : value - expected;
          return (
            <li
              key={p.id}
              data-testid="count-row"
              className="grid grid-cols-2 items-end gap-2 p-3 sm:grid-cols-4"
            >
              <span className="col-span-2 font-medium sm:col-span-1">
                {String(p.name_en)}
              </span>
              <span className="text-small">
                {t('count.expected')}{' '}
                <bdi dir="ltr" data-testid="count-expected">
                  {formatQtyFromMilli(expected, unit)}
                </bdi>
              </span>
              <QtyInput
                label={t('count.counted_for', { name: String(p.name_en) })}
                unit={unit}
                value={value}
                onChange={(v) => void setCounted(draft, p.id, v)}
              />
              <span className="text-small" data-testid="count-diff">
                {diff === null ? (
                  '—'
                ) : (
                  <bdi
                    dir="ltr"
                    className={
                      diff < 0 ? 'text-danger' : diff > 0 ? 'text-success' : ''
                    }
                  >
                    {diff > 0 ? '+' : diff < 0 ? '−' : ''}
                    {formatQtyFromMilli(Math.abs(diff), unit)}
                  </bdi>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          checked={zero}
          onChange={(e) => setZero(e.target.checked)}
        />
        {t('count.zero_uncounted')}
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonPrimary}
          onClick={() => void finish()}
        >
          {t('count.finish')}
        </button>
        <button
          type="button"
          className={buttonQuiet}
          onClick={() => void discardCount(getDb())}
        >
          {t('count.discard')}
        </button>
      </div>
    </div>
  );
}
