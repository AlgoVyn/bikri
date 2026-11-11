import { mulDivRound } from '@bikri/core';
import type { CartLine } from '@bikri/db';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fieldClass } from '../components/classes.ts';
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
          className={`min-h-11 min-w-11 px-3 ${type === k ? 'bg-primary-subtle text-primary-subtle-ink' : ''}`}
          onClick={() => onType(k)}
        >
          {k === 'amount' ? 'Rs' : '%'}
        </button>
      ))}
    </div>
  );
}

/**
 * A cart line's secondary actions. The line keeps qty and price visible; the line
 * discount, note and cost hint live behind "More options" to keep the bill compact.
 */
export function LineEditor({
  line,
  gross,
  revenue,
  showCost,
  onChange,
}: {
  line: CartLine;
  gross: number;
  revenue: number;
  showCost: boolean;
  onChange: (patch: Partial<CartLine>) => void;
}) {
  const { t } = useTranslation();
  const noteId = useId();
  const moreId = useId();
  const [moreOpen, setMoreOpen] = useState(false);
  const cost = mulDivRound(line.qty_milli, line.unit_cost, 1000);
  const margin = revenue > 0 ? mulDivRound(revenue - cost, 100, revenue) : 0;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={moreOpen}
        aria-controls={moreId}
        className="inline-flex min-h-11 items-center self-start text-small text-primary underline underline-offset-2"
        onClick={() => setMoreOpen((open) => !open)}
      >
        {t('sell.more_options')}
      </button>
      {moreOpen ? (
        <div id={moreId} className="flex flex-col gap-2">
          <InlineDiscount line={line} gross={gross} onChange={onChange} />
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
        </div>
      ) : null}
    </div>
  );
}

/** Compact Rs/% selector that lives inside the discount field. */
function DiscountTypeToggle({
  type,
  onChange,
}: {
  type: 'amount' | 'percent';
  onChange: (type: 'amount' | 'percent') => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={`${t('sell.discount_type')}: ${type === 'amount' ? 'Rs' : '%'}`}
      aria-pressed={type === 'percent'}
      title={t('sell.discount_type')}
      className="flex w-11 shrink-0 items-stretch justify-center border-e border-border-strong text-small font-medium"
      onClick={() => onChange(type === 'amount' ? 'percent' : 'amount')}
    >
      <span
        className={`flex w-full items-center justify-center rounded-s-control ${
          type === 'amount'
            ? 'bg-primary-subtle text-primary-subtle-ink'
            : 'text-text-muted hover:bg-surface-2'
        }`}
      >
        {type === 'amount' ? 'Rs' : '%'}
      </span>
    </button>
  );
}

/** Line discount inside More options, with the Rs/% switch in the field. */
function InlineDiscount({
  line,
  gross,
  onChange,
}: {
  line: CartLine;
  gross: number;
  onChange: (patch: Partial<CartLine>) => void;
}) {
  const { t } = useTranslation();
  const type = line.discount_type ?? 'amount';
  const overMax = type === 'amount' && line.discount_value > gross;
  const switchType = (next: 'amount' | 'percent') => {
    if (next === type) return;
    onChange({ discount_type: next, discount_value: 0 });
  };
  return (
    <div>
      <MoneyInput
        key={type}
        label={t('sell.discount')}
        value={line.discount_value || null}
        placeholder="0"
        leading={<DiscountTypeToggle type={type} onChange={switchType} />}
        onChange={(value) =>
          onChange({ discount_type: type, discount_value: value ?? 0 })
        }
      />
      {overMax ? (
        <p className="mt-1 text-small text-danger" data-testid="discount-max">
          {t('sell.discount_max', { amount: formatShopMoney(gross) })}
        </p>
      ) : null}
    </div>
  );
}
