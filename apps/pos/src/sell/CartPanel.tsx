import {
  type CartResult,
  formatMoney,
  type QtyUnit,
  qtyAllowsDecimals,
} from '@bikri/core';
import type { Cart, CartLine } from '@bikri/db';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { SellIcon, UdhaarIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import {
  CART_IDS,
  type CartId,
  isEmptyCart,
  type ShopMoney,
} from '../data/cart.ts';
import { LineEditor } from './LineEditor.tsx';
import { useCustomer } from './useSell.ts';

export type CartPanelProps = {
  carts: Record<CartId, Cart>;
  active: CartId;
  onTab: (id: CartId) => void;
  cart: Cart;
  totals: CartResult;
  money: ShopMoney;
  stock: ReadonlyMap<string, number>;
  selected: string | null;
  onSelect: (key: string | null) => void;
  expanded: string | null;
  onExpand: (key: string | null) => void;
  onChangeLine: (key: string, patch: Partial<CartLine>) => void;
  onRemoveLine: (key: string) => void;
  onPriceChange: (line: CartLine, price: number) => void;
  showCost: boolean;
  onCustomer: () => void;
  onBillDiscount: () => void;
  onHold: () => void;
  onClear: () => void;
  onPay: () => void;
  onHeld: () => void;
  heldCount: number;
};

function itemCount(lines: readonly CartLine[]): number {
  let n = 0;
  for (const l of lines)
    n += qtyAllowsDecimals(l.unit ?? 'pc') ? 1 : Math.round(l.qty_milli / 1000);
  return n;
}

export function CartPanel(p: CartPanelProps) {
  const { t } = useTranslation();
  const customer = useCustomer(p.cart.customer_id);
  const { totals, cart, money } = p;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div role="tablist" aria-label={t('sell.carts')} className="flex gap-1">
        {CART_IDS.map((id, i) => {
          const filled = !isEmptyCart(p.carts[id]);
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={p.active === id}
              className={`relative min-h-11 flex-1 rounded-control border px-2 text-small ${p.active === id ? 'border-primary bg-primary font-medium text-primary-ink' : 'border-border bg-surface-2 text-text-muted hover:bg-surface'}`}
              onClick={() => p.onTab(id)}
            >
              {t('sell.cart_tab', { n: i + 1 })}
              {filled ? (
                <span
                  data-testid="cart-dot"
                  className="ms-1 inline-block size-2 rounded-full bg-primary"
                >
                  <span className="sr-only">{t('sell.cart_has_items')}</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="flex min-h-14 items-center gap-2 rounded-control border border-border bg-surface-2/60 px-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-primary-subtle-ink">
          <UdhaarIcon />
        </span>
        <div className="min-w-0 flex-1" data-testid="cart-customer">
          {customer ? (
            <>
              <span className="font-medium">
                {String(customer.customer.name)}
              </span>
              {customer.balance > 0 ? (
                <span className="ms-2 text-small text-warning">
                  {t('sell.owes', { amount: formatMoney(customer.balance) })}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-text-muted">{t('sell.walk_in')}</span>
          )}
        </div>
        <button
          type="button"
          className="min-h-11 px-2 text-primary"
          onClick={p.onCustomer}
        >
          {t('sell.change_customer')}
        </button>
      </div>

      <ul
        aria-label={t('sell.cart_lines')}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      >
        {cart.lines.length === 0 ? (
          <li className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-text-muted">
              <SellIcon />
            </span>
            <p className="text-small text-text-muted">{t('sell.cart_empty')}</p>
          </li>
        ) : null}
        {cart.lines.map((line, i) => (
          <LineRow
            key={line.key}
            line={line}
            result={totals.lines[i]}
            onHand={line.product_id ? p.stock.get(line.product_id) : undefined}
            isSelected={p.selected === line.key}
            isExpanded={p.expanded === line.key}
            p={p}
          />
        ))}
      </ul>

      <dl
        className="flex flex-col gap-1 rounded-card border border-border bg-surface-2/50 p-3"
        data-testid="cart-totals"
      >
        <Row
          label={t('sell.subtotal', { count: itemCount(cart.lines) })}
          paisa={totals.gross_total}
          testId="total-subtotal"
        />
        {totals.item_discount_total > 0 ? (
          <Row
            label={t('sell.item_discounts')}
            paisa={-totals.item_discount_total}
            testId="total-item-discounts"
          />
        ) : null}
        {totals.bill_discount > 0 ? (
          <div className="flex items-center justify-between gap-2">
            <dt>
              <button
                type="button"
                className="text-primary underline"
                onClick={p.onBillDiscount}
              >
                {t('sell.discount')}
              </button>
            </dt>
            <dd data-testid="total-discount">
              <MoneyText paisa={-totals.bill_discount} />
            </dd>
          </div>
        ) : (
          <div>
            <dt>
              <button
                type="button"
                className="inline-flex min-h-11 items-center gap-2 text-primary"
                disabled={cart.lines.length === 0}
                onClick={p.onBillDiscount}
              >
                {t('sell.add_discount')}
              </button>
            </dt>
            <dd />
          </div>
        )}
        {totals.tax > 0 && money.tax_mode === 'exclusive' ? (
          <Row
            label={t('sell.tax', {
              label: money.tax_label,
              rate: money.tax_rate_bp / 100,
            })}
            paisa={totals.tax}
            testId="total-tax"
          />
        ) : null}
        {totals.rounding !== 0 ? (
          <Row
            label={t('sell.rounding')}
            paisa={totals.rounding}
            testId="total-rounding"
          />
        ) : null}
        <div className="flex items-baseline justify-between gap-2 text-total font-semibold">
          <dt>{t('sell.total_to_pay')}</dt>
          <dd data-testid="total-to-pay">
            <MoneyText paisa={totals.total} />
          </dd>
        </div>
        {totals.tax > 0 && money.tax_mode === 'inclusive' ? (
          <p
            className="text-small text-text-muted"
            data-testid="total-includes-tax"
          >
            {t('sell.includes_tax', {
              label: money.tax_label,
              rate: money.tax_rate_bp / 100,
              amount: formatMoney(totals.tax),
            })}
          </p>
        ) : null}
      </dl>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonQuiet}
          disabled={cart.lines.length === 0}
          onClick={p.onHold}
        >
          {t('sell.hold')}
        </button>
        <button type="button" className={buttonQuiet} onClick={p.onHeld}>
          {t('sell.held_bills', { count: p.heldCount })}
        </button>
        <button
          type="button"
          className={buttonQuiet}
          disabled={isEmptyCart(cart)}
          onClick={p.onClear}
        >
          {t('sell.clear')}
        </button>
      </div>
      <button
        type="button"
        className={`${buttonPrimary} min-h-14 w-full gap-2 text-title`}
        disabled={cart.lines.length === 0}
        onClick={p.onPay}
      >
        {t('sell.take_payment')} · <MoneyText paisa={totals.total} />{' '}
      </button>
    </div>
  );
}

function Row({
  label,
  paisa,
  testId,
}: {
  label: string;
  paisa: number;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt>{label}</dt>
      <dd data-testid={testId}>
        <MoneyText paisa={paisa} />
      </dd>
    </div>
  );
}

function LineRow({
  line,
  result,
  onHand,
  isSelected: selected,
  isExpanded: expanded,
  p,
}: {
  line: CartLine;
  result: CartResult['lines'][number] | undefined;
  onHand: number | undefined;
  isSelected: boolean;
  isExpanded: boolean;
  p: CartPanelProps;
}) {
  const { t } = useTranslation();
  const unit = (line.unit ?? 'pc') as QtyUnit;
  const short =
    line.track_stock === 1 && onHand !== undefined && line.qty_milli > onHand;
  return (
    <li
      data-testid="cart-line"
      aria-current={selected || undefined}
      className={`rounded-card border bg-surface-2/60 p-3 ${selected ? 'border-primary' : 'border-border'}`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="min-h-11 min-w-0 flex-1 text-start"
          aria-expanded={expanded}
          onClick={() => {
            p.onSelect(line.key);
            p.onExpand(expanded ? null : line.key);
          }}
        >
          <span className="ltr-name block font-medium" data-testid="line-name">
            {line.name}
          </span>
          <span className="block text-small text-text-muted">
            <MoneyText paisa={line.unit_price} />
            {line.note ? <span className="ms-2">· {line.note}</span> : null}
          </span>
        </button>
        <span className="pt-2 font-medium" data-testid="line-total">
          <MoneyText paisa={result?.net ?? 0} />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <QtyInput
            label={t('ui.qty_label')}
            ariaLabel={t('sell.qty_of', { name: line.name })}
            unit={unit}
            value={line.qty_milli}
            onChange={(milli) => {
              if (milli !== null)
                p.onChangeLine(line.key, { qty_milli: milli });
            }}
          />
        </div>
        {result && result.discount > 0 ? (
          <span
            className="rounded-full bg-success-subtle px-2 text-small text-success-subtle-ink"
            data-testid="badge-discount"
          >
            <MoneyText paisa={-result.discount} />
          </span>
        ) : null}
        {result?.below_cost === 1 ? (
          <span
            className="rounded-full bg-danger-subtle px-2 text-small font-medium text-danger-subtle-ink"
            data-testid="badge-below-cost"
          >
            {t('sell.below_cost')}
          </span>
        ) : null}
        {short ? (
          <span
            className="rounded-full bg-warning-subtle px-2 text-small text-warning-subtle-ink"
            data-testid="badge-stock"
          >
            {t('sell.only_in_stock', {
              qty: Math.max(0, Math.floor((onHand ?? 0) / 1000)),
            })}
          </span>
        ) : null}
      </div>
      {expanded ? (
        <LineEditor
          line={line}
          gross={result?.gross ?? 0}
          revenue={result?.revenue ?? 0}
          showCost={p.showCost}
          onChange={(patch) => p.onChangeLine(line.key, patch)}
          onPrice={(price) => p.onPriceChange(line, price)}
          onRemove={() => p.onRemoveLine(line.key)}
        />
      ) : null}
    </li>
  );
}
