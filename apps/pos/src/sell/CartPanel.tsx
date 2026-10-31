import { type CartResult, type QtyUnit, qtyAllowsDecimals } from '@bikri/core';
import type { Cart, CartLine } from '@bikri/db';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    <Stack gap="sm" style={{ minHeight: 0, flex: 1 }}>
      <Group gap={6} role="tablist" aria-label={t('sell.carts')} wrap="nowrap">
        {CART_IDS.map((id, i) => {
          const filled = !isEmptyCart(p.carts[id]);
          const total = cartTotals(p.carts[id], p.money).total;
          const active = p.active === id;
          return (
            <UnstyledButton
              key={id}
              role="tab"
              aria-selected={active}
              onClick={() => p.onTab(id)}
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 56,
                borderRadius: 10,
                border: `1px solid ${active ? 'var(--mantine-color-brand-6)' : 'var(--mantine-color-default-border)'}`,
                background: active
                  ? 'var(--mantine-color-brand-6)'
                  : 'var(--mantine-color-default)',
                color: active ? '#fff' : 'var(--mantine-color-dimmed)',
                padding: '8px 10px',
                textAlign: 'start',
              }}
            >
              <Text size="xs" fw={600} truncate>
                {t('sell.cart_tab', { n: i + 1 })}
              </Text>
              <Group gap={4} mt={2} wrap="nowrap">
                {filled ? (
                  <>
                    <Box
                      data-testid="cart-dot"
                      w={6}
                      h={6}
                      style={{ borderRadius: 999, background: 'currentColor' }}
                    />
                    <Text size="xs" fw={active ? 600 : 500} truncate>
                      <MoneyText paisa={total} />
                    </Text>
                  </>
                ) : (
                  <Text size="xs" truncate>
                    {t('sell.empty_tab')}
                  </Text>
                )}
              </Group>
            </UnstyledButton>
          );
        })}
      </Group>

      <Paper p="sm" withBorder>
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={32} radius="xl" variant="light">
            <UdhaarIcon />
          </ThemeIcon>
          <Box style={{ minWidth: 0, flex: 1 }} data-testid="cart-customer">
            {customer ? (
              <Group gap={6} wrap="wrap">
                <Text size="sm" fw={600}>
                  {String(customer.customer.name)}
                </Text>
                {customer.balance > 0 ? (
                  <Text size="xs" c="yellow.7">
                    {t('sell.owes', {
                      amount: formatShopMoney(customer.balance),
                    })}
                  </Text>
                ) : null}
              </Group>
            ) : (
              <Text size="sm" c="dimmed">
                {t('sell.walk_in')}
              </Text>
            )}
          </Box>
          <Button variant="subtle" size="compact-sm" onClick={p.onCustomer}>
            {t('sell.change_customer')}
          </Button>
        </Group>
      </Paper>

      <Stack
        component="ul"
        gap="sm"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          minHeight: 0,
          flex: 1,
          overflowY: 'auto',
        }}
        aria-label={t('sell.cart_lines')}
      >
        {cart.lines.length === 0 ? (
          <Box component="li" style={{ flex: 1, display: 'flex' }}>
            <Stack
              align="center"
              justify="center"
              gap="sm"
              py="xl"
              style={{ flex: 1 }}
            >
              <ThemeIcon size={48} radius="xl" variant="light" color="gray">
                <SellIcon />
              </ThemeIcon>
              <Text size="sm" c="dimmed">
                {t('sell.cart_empty')}
              </Text>
            </Stack>
          </Box>
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
      </Stack>

      <Paper p="sm" withBorder data-testid="cart-totals">
        <Box
          component="dl"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            margin: 0,
          }}
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
            <Group justify="space-between" gap="sm" component="div">
              <Box component="dt">
                <UnstyledButton onClick={p.onBillDiscount}>
                  <Text size="sm" c="brand" td="underline">
                    {t('sell.discount')}
                  </Text>
                </UnstyledButton>
              </Box>
              <Text component="dd" size="sm" data-testid="total-discount">
                <MoneyText paisa={-totals.bill_discount} />
              </Text>
            </Group>
          ) : (
            <Box component="div">
              <Box component="dt">
                <Button
                  variant="subtle"
                  size="compact-xs"
                  disabled={cart.lines.length === 0}
                  onClick={p.onBillDiscount}
                >
                  {t('sell.add_discount')}
                </Button>
              </Box>
              <dd />
            </Box>
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
          <Box
            style={{
              borderTop: '1px solid var(--mantine-color-default-border)',
              margin: '4px 0',
            }}
          />
          <Group justify="space-between" align="baseline" gap="sm">
            <Text component="dt" fw={700} fz={24}>
              {t('sell.total_to_pay')}
            </Text>
            <Text
              component="dd"
              fw={700}
              fz={24}
              data-testid="total-to-pay"
              aria-live="polite"
            >
              <MoneyText paisa={totals.total} />
            </Text>
          </Group>
          {totals.tax > 0 && money.tax_mode === 'inclusive' ? (
            <Text size="xs" c="dimmed" data-testid="total-includes-tax">
              {t('sell.includes_tax', {
                label: money.tax_label,
                rate: money.tax_rate_bp / 100,
                amount: formatShopMoney(totals.tax),
              })}
            </Text>
          ) : null}
        </Box>
      </Paper>

      <Group gap={6} wrap="wrap">
        <Button
          variant="default"
          size="compact-sm"
          disabled={cart.lines.length === 0}
          onClick={p.onHold}
        >
          {t('sell.hold')}
        </Button>
        <Button variant="default" size="compact-sm" onClick={p.onHeld}>
          {t('sell.held_bills', { count: p.heldCount })}
        </Button>
        <Button
          variant="default"
          size="compact-sm"
          disabled={isEmptyCart(cart)}
          onClick={p.onClear}
        >
          {t('sell.clear')}
        </Button>
      </Group>
      {cart.lines.length === 0 ? (
        <Button variant="default" size="lg" fullWidth onClick={p.onAddItem}>
          {t('sell.add_first_item')}
        </Button>
      ) : (
        <Button size="lg" fullWidth onClick={p.onPay}>
          <Group justify="space-between" w="100%">
            <span>{t('sell.take_payment')}</span>
            <MoneyText paisa={totals.total} />
          </Group>
        </Button>
      )}
    </Stack>
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
    <Group justify="space-between" gap="sm">
      <Text component="dt" size="sm">
        {label}
      </Text>
      <Text component="dd" size="sm" data-testid={testId}>
        <MoneyText paisa={paisa} />
      </Text>
    </Group>
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
  const hasBadges =
    (result?.discount ?? 0) > 0 || result?.below_cost === 1 || short;
  return (
    <Paper
      component="li"
      data-testid="cart-line"
      aria-current={selected || undefined}
      p="sm"
      withBorder
      style={{
        borderColor: selected
          ? 'var(--mantine-color-brand-6)'
          : 'var(--mantine-color-default-border)',
        boxShadow: selected
          ? '0 0 0 2px var(--mantine-color-brand-2)'
          : undefined,
      }}
    >
      <Group gap="xs" wrap="nowrap" align="center">
        <UnstyledButton
          style={{
            display: 'flex',
            minWidth: 0,
            flex: 1,
            flexDirection: 'column',
            alignItems: 'flex-start',
          }}
          aria-expanded={expanded}
          onClick={() => {
            p.onSelect(line.key);
            p.onExpand(expanded ? null : line.key);
          }}
        >
          <Text
            className="ltr-name"
            size="sm"
            fw={600}
            truncate
            w="100%"
            data-testid="line-name"
          >
            {line.name}
          </Text>
          {line.note ? (
            <Text size="xs" c="dimmed" truncate w="100%">
              {line.note}
            </Text>
          ) : null}
        </UnstyledButton>
        <Text
          size="sm"
          fw={600}
          style={{ flexShrink: 0 }}
          data-testid="line-total"
        >
          <MoneyText paisa={result?.net ?? 0} />
        </Text>
        <ActionIcon
          variant="subtle"
          color="red"
          size="sm"
          aria-label={`${t('sell.remove_line')} ${line.name}`}
          title={`${t('sell.remove_line')} ${line.name}`}
          onClick={() => p.onRemoveLine(line.key)}
        >
          <span aria-hidden="true">×</span>
        </ActionIcon>
      </Group>

      <Group grow gap="xs" mt="xs" align="flex-start">
        <QtyInput
          dense
          hideLabel
          label={t('ui.qty_label')}
          ariaLabel={t('sell.qty_of', { name: line.name })}
          unit={unit}
          value={line.qty_milli}
          onChange={(milli) => {
            if (milli !== null) p.onChangeLine(line.key, { qty_milli: milli });
          }}
        />
        <InlinePrice line={line} onPrice={p.onPriceChange} />
        <InlineDiscount
          line={line}
          gross={result?.gross ?? 0}
          onChange={(patch) => p.onChangeLine(line.key, patch)}
        />
      </Group>

      {hasBadges ? (
        <Group gap={6} mt="xs" wrap="wrap">
          {result && result.discount > 0 ? (
            <Badge
              color="green"
              variant="light"
              tt="none"
              data-testid="badge-discount"
            >
              <MoneyText paisa={-result.discount} />
            </Badge>
          ) : null}
          {result?.below_cost === 1 ? (
            <Badge
              color="red"
              variant="light"
              tt="none"
              data-testid="badge-below-cost"
            >
              {t('sell.below_cost')}
            </Badge>
          ) : null}
          {short ? (
            <Badge
              color="yellow"
              variant="light"
              tt="none"
              data-testid="badge-stock"
            >
              {t('sell.only_in_stock', {
                qty: Math.max(0, Math.floor((onHand ?? 0) / 1000)),
              })}
            </Badge>
          ) : null}
        </Group>
      ) : null}

      {expanded ? (
        <LineEditor
          line={line}
          revenue={result?.revenue ?? 0}
          showCost={p.showCost}
          onChange={(patch) => p.onChangeLine(line.key, patch)}
        />
      ) : null}
    </Paper>
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

/** Compact Rs/% selector that lives inside the discount field. */
function DiscountTypeToggle({
  type,
  compact,
  onChange,
}: {
  type: 'amount' | 'percent';
  compact?: boolean;
  onChange: (type: 'amount' | 'percent') => void;
}) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a two-button toggle inside the field, not a form fieldset
    <div
      role="group"
      aria-label={t('sell.discount_type')}
      className="flex shrink-0 items-stretch border-e border-border-strong"
    >
      {(['amount', 'percent'] as const).map((key) => (
        <button
          key={key}
          type="button"
          aria-pressed={type === key}
          className={`${compact ? 'w-6' : 'w-7'} text-small font-medium first:rounded-s-control ${
            type === key
              ? 'bg-primary-subtle text-primary-subtle-ink'
              : 'text-text-muted hover:bg-surface-2'
          }`}
          onClick={() => onChange(key)}
        >
          {key === 'amount' ? 'Rs' : '%'}
        </button>
      ))}
    </div>
  );
}

/** Line discount directly on the line, with the Rs/% switch inside the field. */
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
        compact
        label={t('sell.discount')}
        value={line.discount_value || null}
        placeholder="0"
        leading={
          <DiscountTypeToggle compact type={type} onChange={switchType} />
        }
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
