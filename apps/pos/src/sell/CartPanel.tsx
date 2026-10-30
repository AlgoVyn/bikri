import { type CartResult, type QtyUnit, qtyAllowsDecimals } from '@bikri/core';
import type { Cart, CartLine } from '@bikri/db';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
import { SellIcon, UdhaarIcon } from '../components/icons.tsx';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import {
  CART_IDS,
  type CartId,
  cartTotals,
  isEmptyCart,
  type ShopMoney,
} from '../data/cart.ts';
import { formatShopMoney } from '../lib/money';
import { LineEditor, percentToBp } from './LineEditor.tsx';
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
  onAddItem: () => void;
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
          const total = cartTotals(p.carts[id], p.money).total;
          const active = p.active === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`relative flex min-h-14 flex-1 flex-col items-start justify-center rounded-control border px-3 py-2 text-small ${active ? 'border-primary bg-primary font-medium text-primary-ink' : 'border-border bg-surface-2 text-text-muted hover:bg-surface'}`}
              onClick={() => p.onTab(id)}
            >
              <span className="font-medium">
                {t('sell.cart_tab', { n: i + 1 })}
              </span>
              <span
                className={`mt-0.5 flex items-center gap-1 ${active ? 'text-primary-ink' : 'text-text-muted'}`}
              >
                {filled ? (
                  <>
                    <span
                      data-testid="cart-dot"
                      className="size-1.5 rounded-full bg-current"
                    />
                    <MoneyText paisa={total} />
                  </>
                ) : (
                  t('sell.empty_tab')
                )}
              </span>
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
                  {t('sell.owes', {
                    amount: formatShopMoney(customer.balance),
                  })}
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
          <dd data-testid="total-to-pay" aria-live="polite">
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
              amount: formatShopMoney(totals.tax),
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
      {cart.lines.length === 0 ? (
        <button
          type="button"
          className={`${buttonQuiet} min-h-14 w-full text-small`}
          onClick={p.onAddItem}
        >
          {t('sell.add_first_item')}
        </button>
      ) : (
        <button
          type="button"
          className={`${buttonPrimary} min-h-14 w-full gap-2 text-title`}
          onClick={p.onPay}
        >
          {t('sell.take_payment')} · <MoneyText paisa={totals.total} />{' '}
        </button>
      )}
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
        <span className="shrink-0 pt-2 font-medium" data-testid="line-total">
          <MoneyText paisa={result?.net ?? 0} />
        </span>
        <button
          type="button"
          className="flex size-11 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface hover:text-danger"
          aria-label={`${t('sell.remove_line')} ${line.name}`}
          title={`${t('sell.remove_line')} ${line.name}`}
          onClick={() => p.onRemoveLine(line.key)}
        >
          <span aria-hidden="true" className="text-title leading-none">
            ×
          </span>
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-3">
        <QtyInput
          label={t('ui.qty_label')}
          ariaLabel={t('sell.qty_of', { name: line.name })}
          unit={unit}
          value={line.qty_milli}
          onChange={(milli) => {
            if (milli !== null) p.onChangeLine(line.key, { qty_milli: milli });
          }}
        />
        <InlinePrice line={line} onPrice={p.onPriceChange} />
        <div className="col-span-2 xl:col-span-1">
          <InlineDiscount
            line={line}
            gross={result?.gross ?? 0}
            onChange={(patch) => p.onChangeLine(line.key, patch)}
          />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
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
          revenue={result?.revenue ?? 0}
          showCost={p.showCost}
          onChange={(patch) => p.onChangeLine(line.key, patch)}
        />
      ) : null}
    </li>
  );
}

/** Price override directly on the line; commit on blur or Enter. */
function InlinePrice({
  line,
  onPrice,
}: {
  line: CartLine;
  onPrice: (line: CartLine, price: number) => void;
}) {
  const { t } = useTranslation();
  const [price, setPrice] = useState<number | null>(line.unit_price);
  useEffect(() => {
    setPrice(line.unit_price);
  }, [line.unit_price]);
  const commit = () => {
    if (price !== null && price !== line.unit_price) onPrice(line, price);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: commits the price when focus leaves the field
    <div
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit();
      }}
    >
      <MoneyInput
        label={t('sell.unit_price')}
        value={price}
        onChange={setPrice}
      />
    </div>
  );
}

/** Line discount directly on the line, with a compact Rs/% switch. */
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
  const pctId = useId();
  const [pct, setPct] = useState(
    type === 'percent' && line.discount_value
      ? String(line.discount_value / 100)
      : '',
  );
  const overMax = type === 'amount' && line.discount_value > gross;
  const switchType = () => {
    const next = type === 'amount' ? 'percent' : 'amount';
    setPct('');
    onChange({ discount_type: next, discount_value: 0 });
  };
  const toggle = (
    <button
      type="button"
      className="min-h-6 shrink-0 rounded px-1 text-small font-medium text-primary underline"
      aria-label={t('sell.discount_type')}
      title={t('sell.discount_type')}
      onClick={switchType}
    >
      {type === 'amount' ? '%' : 'Rs'}
    </button>
  );
  if (type === 'amount') {
    return (
      <>
        <MoneyInput
          label={t('sell.line_discount')}
          value={line.discount_value || null}
          trailing={toggle}
          onChange={(value) =>
            onChange({ discount_type: 'amount', discount_value: value ?? 0 })
          }
        />
        {overMax ? (
          <p className="mt-1 text-small text-danger" data-testid="discount-max">
            {t('sell.discount_max', { amount: formatShopMoney(gross) })}
          </p>
        ) : null}
      </>
    );
  }
  return (
    <>
      <div className="mb-1 flex items-center justify-between gap-1">
        <label htmlFor={pctId} className="text-small text-text">
          {t('sell.line_discount_pct')}
        </label>
        {toggle}
      </div>
      <input
        id={pctId}
        inputMode="decimal"
        dir="ltr"
        className={fieldClass}
        value={pct}
        onChange={(event) => {
          setPct(event.target.value);
          onChange({
            discount_type: 'percent',
            discount_value: percentToBp(event.target.value) ?? 0,
          });
        }}
      />
    </>
  );
}
