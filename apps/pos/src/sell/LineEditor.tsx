import type { CartLine } from '@bikri/db';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { fieldClass } from '../components/classes.ts';
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

/**
 * The optional details of a cart line. Price and discount live directly on the line now;
 * only the note and an optional cost hint need the extra height.
 */
export function LineEditor({
  line,
  revenue,
  showCost,
  onChange,
}: {
  line: CartLine;
  revenue: number;
  showCost: boolean;
  onChange: (patch: Partial<CartLine>) => void;
}) {
  const { t } = useTranslation();
  const noteId = useId();
  const cost = Math.round((line.qty_milli * line.unit_cost) / 1000);
  const margin =
    revenue > 0 ? Math.round(((revenue - cost) * 100) / revenue) : 0;
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
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
  );
}
