import { formatQtyFromMilli, type QtyUnit } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import { Navigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import { CountIcon } from '../components/icons.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { TaskAside, TaskLayout } from '../components/TaskLayout.tsx';
import { useToast } from '../components/Toast.tsx';
import { useSubmitGuard } from '../components/useSubmitGuard.ts';
import { findByCode } from '../data/cart.ts';
import { ledgerContext, listCategoryOptions } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import {
  type CountDraft,
  type CountScope,
  discardCount,
  finishCount,
  flushCountDraft,
  loadCountDraft,
  startCount,
  updateCount,
} from '../data/stock.ts';
import { categoryName } from '../lib/category.ts';
import { beep } from '../sell/beep.ts';
import { useMediaQuery } from '../shell/useMediaQuery.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { isLatinName } from './format.ts';

const ROW_PX_WIDE = 72;
const ROW_PX_PHONE = 136;
const OVERSCAN = 8;

/** Stock count (screens/09): scope → counted list → Finish count. */
export function StockCountPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const wide = useMediaQuery('(min-width: 640px)');
  const stored = useLiveQuery(() => loadCountDraft(getDb()), []);
  const [draft, setDraft] = useState<CountDraft | null | undefined>(undefined);
  const [products, setProducts] = useState<MasterRow[] | null>(null);
  const categories = useLiveQuery(() => listCategoryOptions(getDb()), []);
  const [scopeKind, setScopeKind] = useState<CountScope['kind']>('all');
  const [categoryId, setCategoryId] = useState('');
  const [zero, setZero] = useState(false);
  const [scan, setScan] = useState('');
  const [finishing, setFinishing] = useState(false);
  const finishGuard = useSubmitGuard();
  const scanId = useId();

  // The live query is the cross-tab/initial source; our own edits update `draft`
  // synchronously so a scan or +1 never waits for the debounced kv write.
  useEffect(() => {
    if (stored === undefined) return;
    setDraft((current) => {
      if (current === undefined) return stored;
      if (stored === null) return null;
      if (current?.started_at !== stored.started_at) return stored;
      return current;
    });
  }, [stored]);

  // Load the products once per count. Do not read db.kv inside this query: Dexie's
  // liveQuery would then subscribe it to every draft write and reload 5,000 rows +
  // sort after each +1 tap. The expected set is frozen when the count starts;
  // `started_at` identifies it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only for a new count
  useEffect(() => {
    if (draft === undefined) return;
    if (draft === null) {
      setProducts([]);
      return;
    }
    let alive = true;
    void (async () => {
      const rows = await getDb().products.bulkGet(Object.keys(draft.expected));
      if (!alive) return;
      setProducts(
        rows
          .filter((p): p is MasterRow => Boolean(p))
          .sort((a, b) => String(a.name_en).localeCompare(String(b.name_en))),
      );
    })();
    return () => {
      alive = false;
    };
  }, [draft?.started_at]);

  // A hidden tab or a route change must not lose the last few debounced taps.
  useEffect(() => {
    const db = getDb();
    const flush = () => {
      void flushCountDraft(db).catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  const setCounted = useCallback(async (id: string, milli: number | null) => {
    const updated = await updateCount(getDb(), id, () => milli);
    if (updated) setDraft(updated);
  }, []);
  const onCounted = useCallback(
    (id: string, milli: number | null) => {
      void setCounted(id, milli);
    },
    [setCounted],
  );

  if (!can('stock.adjust') || readOnly) return <Navigate to="/" replace />;
  if (draft === undefined) return null;

  if (!draft) {
    return (
      <div className={pageClass('standard', 'gap-4')}>
        <SubpageHeader
          backTo="/products"
          backLabel={t('import.back_to_products')}
          icon={<CountIcon />}
          title={t('count.title')}
        />
        <TaskLayout
          aside={
            <TaskAside
              title={t('count.help_title')}
              items={[t('count.help_1'), t('count.help_2'), t('count.help_3')]}
            />
          }
        >
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
                      {categoryName(c, i18n.language)}
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
        </TaskLayout>
      </div>
    );
  }

  const counted = Object.keys(draft.counted).length;
  const finish = async () => {
    if (!finishGuard.lock()) return;
    setFinishing(true);
    try {
      await flushCountDraft(getDb());
      const ctx = await ledgerContext(getDb(), staff?.id ?? '');
      const r = await finishCount(getDb(), draft, { zeroUncounted: zero }, ctx);
      setDraft(null);
      setProducts([]);
      toast.push(t('count.finished', { count: r.movements }), 'info');
    } catch {
      toast.push(t('count.save_failed'), 'error');
    } finally {
      finishGuard.unlock();
      setFinishing(false);
    }
  };
  const onScan = async (code: string) => {
    const product = await findByCode(getDb(), code.trim());
    if (!product || !(product.id in draft.expected)) {
      toast.push(t('count.not_in_count', { code }), 'error');
      return;
    }
    beep();
    const updated = await updateCount(
      getDb(),
      product.id,
      (current) => (current ?? 0) + 1000,
    );
    if (updated) setDraft(updated);
  };

  return (
    <div className={pageClass('focused', 'gap-4')}>
      <SubpageHeader
        backTo="/products"
        backLabel={t('import.back_to_products')}
        icon={<CountIcon />}
        title={t('count.title')}
      />
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
      {products === null ? (
        <p className="text-text-muted">{t('common.loading')}</p>
      ) : (
        <VirtualCountRows
          rows={products}
          draft={draft}
          wide={wide}
          onChange={onCounted}
        />
      )}
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
          disabled={finishing || readOnly}
          onClick={() => void finish()}
        >
          {t('count.finish')}
        </button>
        <button
          type="button"
          className={buttonQuiet}
          onClick={() => {
            void discardCount(getDb()).then(() => {
              setDraft(null);
              setProducts([]);
            });
          }}
        >
          {t('count.discard')}
        </button>
      </div>
    </div>
  );
}

/** Window-scrolled list: only the rows near the viewport are mounted (5,000 products). */
function VirtualCountRows({
  rows,
  draft,
  wide,
  onChange,
}: {
  rows: readonly MasterRow[];
  draft: CountDraft;
  wide: boolean;
  onChange: (id: string, milli: number | null) => void;
}) {
  const { t } = useTranslation();
  const rowPx = wide ? ROW_PX_WIDE : ROW_PX_PHONE;
  const ref = useRef<HTMLUListElement>(null);
  const [range, setRange] = useState({ start: 0, end: 40 });
  useEffect(() => {
    const update = () => {
      const list = ref.current;
      if (!list) return;
      const top = list.getBoundingClientRect().top;
      const start = Math.max(0, Math.floor(-top / rowPx) - OVERSCAN);
      const end = Math.min(
        rows.length,
        Math.max(
          start + 1,
          Math.ceil((window.innerHeight - top) / rowPx) + OVERSCAN,
        ),
      );
      setRange((current) =>
        current.start === start && current.end === end
          ? current
          : { start, end },
      );
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [rows.length, rowPx]);
  const visible = rows.slice(range.start, range.end);
  return (
    <ul
      ref={ref}
      className="relative rounded-card border border-border bg-surface"
      style={{ height: rows.length * rowPx }}
      aria-label={t('count.title')}
    >
      {visible.map((product, index) => (
        <CountRow
          key={product.id}
          product={product}
          expected={draft.expected[product.id] ?? 0}
          value={
            Object.hasOwn(draft.counted, product.id)
              ? (draft.counted[product.id] ?? 0)
              : null
          }
          position={range.start + index}
          setSize={rows.length}
          rowPx={rowPx}
          wide={wide}
          onChange={onChange}
        />
      ))}
    </ul>
  );
}

const CountRow = memo(function CountRow({
  product,
  expected,
  value,
  position,
  setSize,
  rowPx,
  wide,
  onChange,
}: {
  product: MasterRow;
  expected: number;
  value: number | null;
  position: number;
  setSize: number;
  rowPx: number;
  wide: boolean;
  onChange: (id: string, milli: number | null) => void;
}) {
  const { t } = useTranslation();
  const unit = String(product.unit ?? 'pc') as QtyUnit;
  const diff = value === null ? null : value - expected;
  const diffText =
    diff === null
      ? '—'
      : `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${formatQtyFromMilli(Math.abs(diff), unit)}`;
  const name = (
    <span
      className={`data-name line-clamp-2 min-w-0 font-medium ${isLatinName(String(product.name_en)) ? 'ltr-name' : ''}`}
      title={String(product.name_en)}
    >
      {String(product.name_en)}
    </span>
  );
  const qty = (
    <QtyInput
      dense
      label={t('count.counted')}
      ariaLabel={t('count.counted_for', { name: String(product.name_en) })}
      unit={unit}
      value={value}
      onChange={(milli) => onChange(String(product.id), milli)}
    />
  );
  return (
    <li
      data-testid="count-row"
      className="absolute inset-x-0 border-b border-border last:border-b-0"
      style={{ top: position * rowPx, height: rowPx }}
      aria-setsize={setSize}
      aria-posinset={position + 1}
    >
      {wide ? (
        <div className="grid h-full grid-cols-[minmax(0,1fr)_6rem_minmax(11rem,13rem)_6rem] items-center gap-3 px-3">
          {name}
          <span className="text-small">
            <span className="mb-1 block text-text-muted">
              {t('count.expected')}
            </span>
            <bdi dir="ltr" className="font-mono" data-testid="count-expected">
              {formatQtyFromMilli(expected, unit)}
            </bdi>
          </span>
          {qty}
          <span className="text-small">
            <span className="mb-1 block text-text-muted">
              {t('count.difference')}
            </span>
            <bdi
              dir="ltr"
              className={`font-mono ${
                diff === null
                  ? ''
                  : diff < 0
                    ? 'text-danger'
                    : diff > 0
                      ? 'text-success'
                      : ''
              }`}
              data-testid="count-diff"
            >
              {diffText}
            </bdi>
          </span>
        </div>
      ) : (
        <div className="grid h-full grid-cols-[minmax(0,1fr)_10.5rem] grid-rows-[auto_auto_auto] items-center gap-x-3 gap-y-0.5 px-3">
          <span className="col-start-1 row-start-1">{name}</span>
          <span className="col-start-1 row-start-2 flex items-baseline gap-2 text-small">
            <span className="text-text-muted">{t('count.expected')}</span>
            <bdi dir="ltr" className="font-mono" data-testid="count-expected">
              {formatQtyFromMilli(expected, unit)}
            </bdi>
          </span>
          <span className="col-start-1 row-start-3 flex items-baseline gap-2 text-small">
            <span className="text-text-muted">{t('count.difference')}</span>
            <bdi
              dir="ltr"
              className={`font-mono ${
                diff === null
                  ? ''
                  : diff < 0
                    ? 'text-danger'
                    : diff > 0
                      ? 'text-success'
                      : ''
              }`}
              data-testid="count-diff"
            >
              {diffText}
            </bdi>
          </span>
          <div className="col-start-2 row-span-3 row-start-1">{qty}</div>
        </div>
      )}
    </li>
  );
});
