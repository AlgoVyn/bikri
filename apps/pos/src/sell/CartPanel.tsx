import { type CartResult, type QtyUnit, qtyAllowsDecimals } from '@bikri/core';
import type { Cart, CartBackdate, CartLine } from '@bikri/db';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonDangerQuiet,
  buttonPrimary,
  buttonQuiet,
} from '../components/classes.ts';
import {
  ChevronRightIcon,
  CloseIcon,
  SalesIcon,
  UdhaarIcon,
} from '../components/icons.tsx';
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
import { formatBusinessDate } from '../lib/date.ts';
import { formatShopMoney } from '../lib/money';
import { qtyWithUnit } from '../products/format.ts';
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
  onAddItem: () => void;
  onHeld: () => void;
  heldCount: number;
  backdate?: CartBackdate | null;
  backdateStaffName?: string;
  onCancelBackdate: () => void;
};

function itemCount(lines: readonly CartLine[]): number {
  let n = 0;
  for (const l of lines)
    n += qtyAllowsDecimals(l.unit ?? 'pc') ? 1 : Math.round(l.qty_milli / 1000);
  return n;
}

export function CartPanel(p: CartPanelProps) {
  const { t, i18n } = useTranslation();
  const customer = useCustomer(p.cart.customer_id);
  const { totals, cart, money } = p;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      {p.backdate ? (
        <div
          data-testid="backdate-banner"
          className="rounded-control border border-warning bg-warning-subtle p-2 text-small text-warning-subtle-ink"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {t('sell.backdate_banner', {
                  date: formatBusinessDate(
                    p.backdate.business_date,
                    i18n.language,
                  ),
                  staff: p.backdateStaffName || '—',
                })}
              </p>
              <p className="truncate" title={p.backdate.reason}>
                {p.backdate.reason}
              </p>
            </div>
            <button
              type="button"
              className="min-h-11 shrink-0 px-2 underline underline-offset-2"
              onClick={p.onCancelBackdate}
            >
              {t('sell.backdate_cancel')}
            </button>
          </div>
        </div>
      ) : null}
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
              className={`relative flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-control border px-2 py-1 text-small transition-colors duration-150 lg:min-h-10 ${active ? 'border-primary bg-primary font-medium text-primary-ink' : 'border-border bg-surface-2 text-text-muted hover:bg-surface'}`}
              onClick={() => p.onTab(id)}
            >
              <span className="truncate font-medium">
                {t('sell.cart_tab', { n: i + 1 })}
              </span>
              {filled ? (
                <>
                  <span
                    data-testid="cart-dot"
                    className="size-1.5 shrink-0 rounded-full bg-current"
                  />
                  <span className="hidden min-w-0 truncate text-caption sm:inline">
                    <MoneyText paisa={total} />
                  </span>
                </>
              ) : (
                <span className="hidden truncate text-caption sm:inline">
                  {t('sell.empty_tab')}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex min-h-11 items-center gap-2 rounded-control border border-border bg-surface-2/60 px-2.5 lg:min-h-10">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-primary-subtle-ink [&_svg]:size-4">
          <UdhaarIcon />
        </span>
        <div className="min-w-0 flex-1 text-small" data-testid="cart-customer">
          {customer ? (
            <>
              <span className="font-medium">
                {String(customer.customer.name)}
              </span>
              {customer.balance > 0 ? (
                <span className="ms-2 text-warning">
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
          className="min-h-11 px-2 text-small text-primary lg:min-h-9"
          onClick={p.onCustomer}
        >
          {t('sell.change_customer')}
        </button>
      </div>

      <ul
        aria-label={t('sell.cart_lines')}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {cart.lines.length === 0 ? (
          <li className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-surface-2 text-text-muted [&_svg]:size-5">
              <SalesIcon />
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
        className="flex flex-col gap-0.5 rounded-card border border-border bg-surface-2/50 px-2.5 py-1.5 text-small"
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
        <div className="flex items-center justify-between gap-2">
          <dt className="flex min-w-0 items-center">
            {totals.bill_discount > 0 ? (
              <button
                type="button"
                className="inline-flex min-h-11 items-center text-primary underline"
                onClick={p.onBillDiscount}
              >
                {t('sell.discount')}
              </button>
            ) : (
              <button
                type="button"
                className="inline-flex min-h-11 items-center text-primary underline underline-offset-2 disabled:pointer-events-none disabled:text-text-muted disabled:no-underline"
                disabled={cart.lines.length === 0}
                onClick={p.onBillDiscount}
              >
                {t('sell.add_discount')}
              </button>
            )}
          </dt>
          {totals.bill_discount > 0 ? (
            <dd data-testid="total-discount">
              <MoneyText paisa={-totals.bill_discount} />
            </dd>
          ) : null}
        </div>
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
        <div className="mt-0.5 flex items-baseline justify-between gap-2 text-title font-semibold">
          <dt>{t('sell.total_to_pay')}</dt>
          <dd data-testid="total-to-pay" aria-live="polite">
            <MoneyText paisa={totals.total} />
          </dd>
        </div>
        {totals.tax > 0 && money.tax_mode === 'inclusive' ? (
          <p
            className="text-caption text-text-muted"
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

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={`${buttonQuiet} max-sm:px-3 lg:min-h-9 lg:px-3 lg:text-small`}
          disabled={cart.lines.length === 0}
          onClick={p.onHold}
        >
          {t('sell.hold')}
        </button>
        <button
          type="button"
          className={`${buttonQuiet} max-sm:px-3 lg:min-h-9 lg:px-3 lg:text-small`}
          onClick={p.onHeld}
        >
          {t('sell.held_bills', { count: p.heldCount })}
        </button>
        <button
          type="button"
          className={`${buttonDangerQuiet} max-sm:px-3 lg:min-h-9 lg:px-3 lg:text-small`}
          disabled={isEmptyCart(cart)}
          onClick={p.onClear}
        >
          {t('sell.clear')}
        </button>
        {cart.lines.length > 0 ? (
          <button
            type="button"
            className={`${buttonPrimary} max-sm:px-3 text-small lg:ms-auto lg:min-h-9 lg:px-3`}
            onClick={p.onPay}
          >
            {t('sell.take_payment')}
          </button>
        ) : null}
      </div>
      {cart.lines.length === 0 ? (
        <button
          type="button"
          className={`${buttonQuiet} min-h-14 w-full text-small lg:min-h-12`}
          onClick={p.onAddItem}
        >
          {t('sell.add_first_item')}
        </button>
      ) : null}
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
  const ref = useRef<HTMLLIElement>(null);
  const unit = (line.unit ?? 'pc') as QtyUnit;
  const short =
    line.track_stock === 1 && onHand !== undefined && line.qty_milli > onHand;
  // Keep the line being edited (usually the one just scanned) inside the visible list.
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [expanded]);
  return (
    <li
      ref={ref}
      data-testid="cart-line"
      aria-current={selected || undefined}
      className={
        expanded
          ? 'rounded-card border border-primary bg-surface-2/60'
          : `border-b border-border last:border-b-0 ${selected ? 'bg-surface-2/60' : ''}`
      }
    >
      <div className="flex items-center gap-1.5 px-1">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-0.5 text-start"
          aria-expanded={expanded}
          onClick={() => {
            p.onSelect(line.key);
            p.onExpand(expanded ? null : line.key);
          }}
        >
          <ChevronRightIcon
            className={`size-4 shrink-0 text-text-muted ${expanded ? 'rotate-90 rtl:rotate-90' : 'rtl:rotate-180'}`}
          />
          <span className="min-w-0 flex-1">
            <span
              className="ltr-name block truncate font-medium"
              data-testid="line-name"
            >
              {line.name}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-text-muted">
              <span className="shrink-0 whitespace-nowrap">
                {qtyWithUnit(t, line.qty_milli, unit)} ×{' '}
                <MoneyText paisa={line.unit_price} />
              </span>
              {result && result.discount > 0 ? (
                <span
                  className="shrink-0 rounded-full bg-success-subtle px-1.5 text-caption text-success-subtle-ink"
                  data-testid="badge-discount"
                >
                  <MoneyText paisa={-result.discount} />
                </span>
              ) : null}
              {result?.below_cost === 1 ? (
                <span
                  className="shrink-0 rounded-full bg-danger-subtle px-1.5 text-caption font-medium text-danger-subtle-ink"
                  data-testid="badge-below-cost"
                >
                  {t('sell.below_cost')}
                </span>
              ) : null}
              {short ? (
                <span
                  className="shrink-0 rounded-full bg-warning-subtle px-1.5 text-caption text-warning-subtle-ink"
                  data-testid="badge-stock"
                >
                  {t('sell.only_in_stock', {
                    qty: Math.max(0, Math.floor((onHand ?? 0) / 1000)),
                  })}
                </span>
              ) : null}
              {line.note ? (
                <span className="min-w-0 truncate" title={line.note}>
                  {line.note}
                </span>
              ) : null}
            </span>
          </span>
          <span className="shrink-0 font-medium" data-testid="line-total">
            <MoneyText paisa={result?.net ?? 0} />
          </span>
        </button>
        <button
          type="button"
          className="flex size-11 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface hover:text-danger"
          aria-label={`${t('sell.remove_line')} ${line.name}`}
          title={`${t('sell.remove_line')} ${line.name}`}
          onClick={() => p.onRemoveLine(line.key)}
        >
          <CloseIcon className="size-5" />
        </button>
      </div>

      {expanded ? (
        <div className="border-t border-border px-2 pb-1.5 pt-1">
          <div className="grid grid-cols-[minmax(140px,auto)_minmax(90px,1fr)] items-start gap-1.5 sm:grid-cols-2">
            <QtyInput
              dense
              hideLabel
              label={t('ui.qty_label')}
              ariaLabel={t('sell.qty_of', { name: line.name })}
              unit={unit}
              value={line.qty_milli}
              onChange={(milli) => {
                if (milli !== null)
                  p.onChangeLine(line.key, { qty_milli: milli });
              }}
            />
            <InlinePrice line={line} onPrice={p.onPriceChange} />
          </div>
          <LineEditor
            line={line}
            gross={result?.gross ?? 0}
            revenue={result?.revenue ?? 0}
            showCost={p.showCost}
            onChange={(patch) => p.onChangeLine(line.key, patch)}
          />
        </div>
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
        compact
        label={t('sell.unit_price')}
        value={price}
        onChange={setPrice}
      />
    </div>
  );
}
