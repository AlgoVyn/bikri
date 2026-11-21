import { type CartResult, mulDivRound, type QtyUnit } from '@bikri/core';
import type { Cart, CartBackdate, CartLine } from '@bikri/db';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
import { isLatinName, qtyWithUnit } from '../products/format.ts';
import type { CartOrder } from '../shell/devicePrefs.ts';
import { cartItemCount } from './itemCount.ts';
import { InlineDiscount, LineEditor } from './LineEditor.tsx';
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
  onBundleQty: (group: string, qty: number) => void;
  onBundlePrice: (group: string, price: number) => void;
  onBundleDiscount: (
    group: string,
    type: 'amount' | 'percent',
    value: number,
  ) => void;
  onRemoveBundle: (group: string) => void;
  showCost: boolean;
  onCustomer: () => void;
  onRemarks: () => void;
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
  cartOrder: CartOrder;
  /** Bumped when a manager override is dismissed, so a rejected price resets. */
  priceReset?: number;
};

export const CartPanel = memo(function CartPanel(p: CartPanelProps) {
  const { t, i18n } = useTranslation();
  const customer = useCustomer(p.cart.customer_id);
  const { totals, cart, money } = p;
  // The three tab totals depend only on the carts and the shop money settings, not on
  // the search box or the cart's own line rendering.
  const tabTotals = useMemo(
    () => CART_IDS.map((id) => cartTotals(p.carts[id], p.money).total),
    [p.carts, p.money],
  );
  // The cart keeps newest first in memory, so only the "bottom" preference reverses.
  const displayLines = cart.lines.map((line, index) => ({ line, index }));
  if (p.cartOrder === 'newest_last') displayLines.reverse();
  const blocks: Array<
    | { kind: 'line'; line: CartLine; index: number }
    | {
        kind: 'bundle';
        group: string;
        lines: { line: CartLine; index: number }[];
      }
  > = [];
  const seenGroups = new Set<string>();
  for (const entry of displayLines) {
    const group = entry.line.bundle_group;
    if (!group) {
      blocks.push({ kind: 'line', ...entry });
      continue;
    }
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    blocks.push({
      kind: 'bundle',
      group,
      lines: displayLines.filter((row) => row.line.bundle_group === group),
    });
  }
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
          const total = tabTotals[i] ?? 0;
          const active = p.active === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`relative flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-control border px-2 py-1 text-small transition-colors duration-150 lg:min-h-12 ${active ? 'border-primary bg-primary font-medium text-primary-ink' : 'border-border bg-surface-2 text-text-muted hover:bg-surface'}`}
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

      <div className="flex min-h-11 items-center gap-2 rounded-control border border-border bg-surface-2/60 px-2.5 lg:min-h-12">
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
          className="min-h-11 px-2 text-small text-primary lg:min-h-12"
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
        {blocks.map((block) =>
          block.kind === 'line' ? (
            <LineRow
              key={block.line.key}
              line={block.line}
              result={totals.lines[block.index]}
              onHand={
                block.line.product_id
                  ? p.stock.get(block.line.product_id)
                  : undefined
              }
              isSelected={p.selected === block.line.key}
              isExpanded={p.expanded === block.line.key}
              p={p}
            />
          ) : (
            <BundleRows
              key={block.group}
              group={block.group}
              lines={block.lines}
              selected={p.selected === block.group}
              expanded={p.expanded === block.group}
              p={p}
            />
          ),
        )}
      </ul>

      <dl
        className="flex flex-col gap-0.5 rounded-card border border-border bg-surface-2/50 px-2.5 py-1.5 text-small"
        data-testid="cart-totals"
      >
        <Row
          label={t('sell.subtotal', { count: cartItemCount(cart.lines) })}
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
          <dt className="flex min-w-0 flex-wrap items-center gap-x-2">
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
            {!cart.note.trim() && totals.bill_discount <= 0 ? (
              <button
                type="button"
                className="inline-flex min-h-11 items-center text-primary underline underline-offset-2 disabled:pointer-events-none disabled:text-text-muted disabled:no-underline"
                disabled={cart.lines.length === 0}
                onClick={p.onRemarks}
              >
                {t('sell.add_remarks')}
              </button>
            ) : null}
          </dt>
          {totals.bill_discount > 0 ? (
            <dd data-testid="total-discount">
              <MoneyText paisa={-totals.bill_discount} />
            </dd>
          ) : null}
        </div>
        {totals.bill_discount > 0 && !cart.note.trim() ? (
          <div className="-mt-2">
            <button
              type="button"
              className="inline-flex min-h-11 items-center text-small text-primary underline underline-offset-2"
              onClick={p.onRemarks}
            >
              {t('sell.add_remarks')}
            </button>
          </div>
        ) : null}
        {cart.note.trim() ? (
          <div className="flex min-w-0 items-center justify-between gap-2">
            <dt
              className="min-w-0 truncate text-text-muted"
              title={cart.note}
              data-testid="cart-remarks"
            >
              {t('sell.remarks')}: {cart.note}
            </dt>
            <dd>
              <button
                type="button"
                className="inline-flex min-h-11 items-center text-small text-primary underline underline-offset-2"
                onClick={p.onRemarks}
              >
                {t('common.edit')}
              </button>
            </dd>
          </div>
        ) : null}
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
          className={`${buttonQuiet} max-sm:px-3 lg:min-h-12 lg:px-3 lg:text-small`}
          disabled={cart.lines.length === 0}
          onClick={p.onHold}
        >
          {t('sell.hold')}
        </button>
        <button
          type="button"
          className={`${buttonQuiet} max-sm:px-3 lg:min-h-12 lg:px-3 lg:text-small`}
          onClick={p.onHeld}
        >
          {t('sell.held_bills', { count: p.heldCount })}
        </button>
        <button
          type="button"
          className={`${buttonDangerQuiet} max-sm:px-3 lg:min-h-12 lg:px-3 lg:text-small`}
          disabled={isEmptyCart(cart)}
          onClick={p.onClear}
        >
          {t('sell.clear')}
        </button>
        <button
          type="button"
          className={`${buttonPrimary} max-sm:px-3 text-small lg:ms-auto lg:min-h-12 lg:px-3`}
          onClick={isEmptyCart(cart) ? p.onAddItem : p.onPay}
        >
          {isEmptyCart(cart) ? t('sell.add_items') : t('sell.take_payment')}
        </button>
      </div>
    </div>
  );
});

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

function BundleRows({
  group,
  lines,
  selected,
  expanded,
  p,
}: {
  group: string;
  lines: { line: CartLine; index: number }[];
  selected: boolean;
  expanded: boolean;
  p: CartPanelProps;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement>(null);
  const first = lines[0]?.line;
  const qty = Number(first?.bundle_qty ?? 0);
  const price = Number(first?.bundle_price ?? 0);
  const total = price * qty;
  const cost = lines.reduce(
    (sum, { line }) => sum + mulDivRound(line.qty_milli, line.unit_cost, 1000),
    0,
  );
  const margin = total > 0 ? mulDivRound(total - cost, 100, total) : 0;
  const tracked = lines.filter(({ line }) => line.track_stock === 1);
  let available: number | undefined;
  for (const { line } of tracked) {
    const onHand = line.product_id ? p.stock.get(line.product_id) : undefined;
    if (onHand === undefined) continue;
    const perBundle = Math.max(
      1,
      Number(line.bundle_component_qty_milli ?? 1000),
    );
    const canMake = Math.floor(onHand / perBundle);
    available =
      available === undefined ? canMake : Math.min(available, canMake);
  }
  const short = available !== undefined && available < qty;
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [expanded]);
  if (!first) return null;
  return (
    <li
      ref={ref}
      data-testid="bundle-group"
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
            p.onSelect(group);
            p.onExpand(expanded ? null : group);
          }}
        >
          <ChevronRightIcon
            className={`size-4 shrink-0 text-text-muted ${expanded ? 'rotate-90 rtl:rotate-90' : 'rtl:rotate-180'}`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={`data-name min-w-0 truncate font-medium ${isLatinName(String(first.bundle_name ?? first.name)) ? 'ltr-name' : ''}`}
                data-testid="line-name"
              >
                {String(first.bundle_name ?? first.name)}
              </span>
              <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-caption font-medium text-text-muted">
                {t('sell.bundle_pill')}
              </span>
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-small text-text-muted">
              <span className="shrink-0 whitespace-nowrap">
                {qty} × <MoneyText paisa={price} /> ·{' '}
                {t('sell.bundle_item_count', { count: lines.length })}
              </span>
              {short ? (
                <span className="shrink-0 rounded-full bg-warning-subtle px-1.5 text-caption text-warning-subtle-ink">
                  {t('sell.only_in_stock', {
                    qty: Math.max(0, available ?? 0),
                  })}
                </span>
              ) : null}
              {cost > total ? (
                <span
                  className="shrink-0 rounded-full bg-danger-subtle px-1.5 text-caption font-medium text-danger-subtle-ink"
                  data-testid="badge-below-cost"
                >
                  {t('sell.below_cost')}
                </span>
              ) : null}
            </span>
          </span>
          <span className="shrink-0 font-medium" data-testid="line-total">
            <MoneyText paisa={total} />
          </span>
        </button>
        <button
          type="button"
          className="flex size-11 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface hover:text-danger"
          aria-label={`${t('sell.remove_line')} ${String(first.bundle_name ?? '')}`}
          title={`${t('sell.remove_line')} ${String(first.bundle_name ?? '')}`}
          onClick={() => p.onRemoveBundle(group)}
        >
          <CloseIcon className="size-5" />
        </button>
      </div>
      {expanded ? (
        <ul className="pb-1">
          {lines.map(({ line }) => (
            <li
              key={line.key}
              className="flex items-baseline justify-between gap-2 px-3 ps-8 text-small text-text-muted"
              data-testid="bundle-component"
            >
              <span
                className={`data-name min-w-0 truncate ${isLatinName(line.name) ? 'ltr-name' : ''}`}
              >
                {line.name}
              </span>
              <span className="shrink-0 whitespace-nowrap">
                {qtyWithUnit(t, line.qty_milli, (line.unit ?? 'pc') as QtyUnit)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {expanded ? (
        <div className="border-t border-border px-2 pb-1.5 pt-1">
          <div className="grid grid-cols-[minmax(120px,auto)_minmax(140px,1fr)] items-start gap-1.5 sm:grid-cols-2">
            <QtyInput
              dense
              hideLabel
              commitOnBlur
              label={t('sell.bundle_qty')}
              ariaLabel={t('sell.bundle_qty')}
              unit="pc"
              value={qty * 1000}
              onChange={(milli) => {
                if (milli !== null)
                  p.onBundleQty(group, Math.round(milli / 1000));
              }}
            />
            <BundleInlinePrice
              key={`bundle-price:${group}:${p.priceReset ?? 0}`}
              price={price}
              listPrice={Number(first.bundle_list_price ?? price)}
              onPrice={(next) => p.onBundlePrice(group, next)}
            />
          </div>
          <BundleOptions
            line={first}
            gross={Number(
              first.bundle_base_price ?? first.bundle_list_price ?? price,
            )}
            showCost={p.showCost}
            cost={cost}
            total={total}
            margin={margin}
            onDiscount={(type, value) => p.onBundleDiscount(group, type, value)}
          />
          <p className="mt-1 text-caption text-text-muted">
            {t('sell.bundle_components_readonly')}
          </p>
        </div>
      ) : null}
    </li>
  );
}

/** Bundle options mirror a normal line: More options, group discount and cost hint. */
function BundleOptions({
  line,
  gross,
  showCost,
  cost,
  total,
  margin,
  onDiscount,
}: {
  line: CartLine;
  gross: number;
  showCost: boolean;
  cost: number;
  total: number;
  margin: number;
  onDiscount: (type: 'amount' | 'percent', value: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const type = line.bundle_discount_type ?? 'amount';
  const fake: CartLine = {
    ...line,
    qty_milli: 1000,
    unit_price: gross,
    list_price: gross,
    discount_type: type,
    discount_value: line.bundle_discount_value ?? 0,
  };
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex min-h-11 items-center self-start text-small text-primary underline underline-offset-2"
        onClick={() => setOpen((value) => !value)}
      >
        {t('sell.more_options')}
      </button>
      {open ? (
        <div className="flex flex-col gap-2">
          <InlineDiscount
            line={fake}
            gross={gross}
            onChange={(patch) => {
              if (
                patch.discount_type !== undefined ||
                patch.discount_value !== undefined
              )
                onDiscount(
                  patch.discount_type ?? type,
                  patch.discount_value ?? 0,
                );
            }}
          />
          {showCost && total > 0 ? (
            <p className="text-small text-text-muted" data-testid="bundle-cost">
              {t('sell.cost_margin', {
                cost: formatShopMoney(cost),
                margin,
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Whole-bundle price override; commit on blur or Enter like a normal line price. */
function BundleInlinePrice({
  price,
  listPrice,
  onPrice,
}: {
  price: number;
  listPrice: number;
  onPrice: (price: number) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState<number | null>(price);
  useEffect(() => {
    setValue(price);
  }, [price]);
  const commit = () => {
    if (value !== null && value !== price) onPrice(value);
  };
  return (
    <div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: commits the price when focus leaves the field */}
      <div
        title={t('sell.unit_price')}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          commit();
        }}
      >
        <MoneyInput
          compact
          label={t('sell.bundle_price')}
          value={value}
          onChange={setValue}
        />
      </div>
      {price !== listPrice ? (
        <p className="mt-1 text-caption text-text-muted">
          {t('sell.bundle_list_price', {
            amount: formatShopMoney(listPrice),
          })}
        </p>
      ) : null}
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
              className={`data-name block truncate font-medium ${isLatinName(line.name) ? 'ltr-name' : ''}`}
              title={line.name}
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
              commitOnBlur
              label={t('ui.qty_label')}
              ariaLabel={t('sell.qty_of', { name: line.name })}
              unit={unit}
              value={line.qty_milli}
              onChange={(milli) => {
                if (milli !== null)
                  p.onChangeLine(line.key, { qty_milli: milli });
              }}
            />
            <InlinePrice
              key={`price:${line.key}:${p.priceReset ?? 0}`}
              line={line}
              onPrice={p.onPriceChange}
            />
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
      title={t('sell.unit_price')}
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
