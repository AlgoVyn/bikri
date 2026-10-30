import type { CartLine } from '@bikri/db';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet, fieldClass } from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { NOTE_MAX } from '../data/cart.ts';
import { formatShopMoney } from '../lib/money';

/** Percent text ("5", "12.5") to basis points, or null. */
export function percentToBp(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/u.test(trimmed)) return null;
  const bp = Math.round(Number(trimmed) * 100);
  return bp <= 10000 ? bp : null;
}

export function DiscountToggle({
  type,
  onType,
}: {
  type: 'amount' | 'percent';
  onType: (type: 'amount' | 'percent') => void;
}) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a two-button toggle, not a form fieldset
    <div
      role="group"
      aria-label={t('sell.discount_type')}
      className="inline-flex rounded-control border border-border-strong"
    >
      {(['amount', 'percent'] as const).map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={type === k}
          className={`min-h-11 min-w-11 px-3 ${type === k ? 'bg-primary text-primary-ink' : ''}`}
          onClick={() => onType(k)}
        >
          {k === 'amount' ? 'Rs' : '%'}
        </button>
      ))}
    </div>
  );
}

/** The expanded part of a cart line: price override, discount, note, remove (screens/05). */
export function LineEditor({
  line,
  gross,
  revenue,
  showCost,
  onChange,
  onPrice,
  onRemove,
}: {
  line: CartLine;
  gross: number;
  revenue: number;
  showCost: boolean;
  onChange: (patch: Partial<CartLine>) => void;
  onPrice: (price: number) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const noteId = useId();
  const pctId = useId();
  const [price, setPrice] = useState<number | null>(line.unit_price);
  const type = line.discount_type ?? 'amount';
  const [pct, setPct] = useState(
    type === 'percent' && line.discount_value
      ? String(line.discount_value / 100)
      : '',
  );
  const overMax = type === 'amount' && line.discount_value > gross;
  const cost = Math.round((line.qty_milli * line.unit_cost) / 1000);
  const margin =
    revenue > 0 ? Math.round(((revenue - cost) * 100) / revenue) : 0;
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: commits the price when focus leaves the field */}
      <div
        onBlur={() => {
          if (price !== null && price !== line.unit_price) onPrice(price);
        }}
      >
        <MoneyInput
          label={t('sell.unit_price')}
          value={price}
          onChange={setPrice}
        />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <DiscountToggle
          type={type}
          onType={(k) => {
            setPct('');
            onChange({ discount_type: k, discount_value: 0 });
          }}
        />
        <div className="min-w-0 flex-1">
          {type === 'amount' ? (
            <>
              <MoneyInput
                label={t('sell.line_discount')}
                value={line.discount_value || null}
                onChange={(v) =>
                  onChange({ discount_type: 'amount', discount_value: v ?? 0 })
                }
              />
              {overMax ? (
                <p
                  className="mt-1 text-small text-danger"
                  data-testid="discount-max"
                >
                  {t('sell.discount_max', { amount: formatShopMoney(gross) })}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <label htmlFor={pctId} className="mb-1 block text-small">
                {t('sell.line_discount_pct')}
              </label>
              <input
                id={pctId}
                inputMode="decimal"
                dir="ltr"
                className={fieldClass}
                value={pct}
                onChange={(e) => {
                  setPct(e.target.value);
                  const bp = percentToBp(e.target.value);
                  onChange({
                    discount_type: 'percent',
                    discount_value: bp ?? 0,
                  });
                }}
              />
            </>
          )}
        </div>
      </div>
      <div>
        <label htmlFor={noteId} className="mb-1 block text-small">
          {t('sell.line_note')}
        </label>
        <input
          id={noteId}
          className={fieldClass}
          maxLength={NOTE_MAX}
          value={line.note ?? ''}
          onChange={(e) => onChange({ note: e.target.value })}
        />
      </div>
      {showCost && line.unit_cost > 0 ? (
        <p className="text-small text-text-muted" data-testid="line-cost">
          {t('sell.cost_margin', {
            cost: formatShopMoney(line.unit_cost),
            margin,
          })}
        </p>
      ) : null}
      <button
        type="button"
        className={`${buttonQuiet} self-start text-danger`}
        onClick={onRemove}
      >
        {t('sell.remove_line')}
      </button>
    </div>
  );
}
