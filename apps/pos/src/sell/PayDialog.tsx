import { type CartResult, cashChips, newId } from '@bikri/core';
import type { Cart, SyncedRow } from '@bikri/db';
import {
  Box,
  Button,
  Checkbox,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  type FormEvent,
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  BankIcon,
  CardIcon,
  CashIcon,
  UdhaarIcon,
} from '../components/icons.tsx';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  addOverride,
  type CartId,
  hasOverride,
  type ShopMoney,
} from '../data/cart.ts';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import {
  completeSale,
  mergeRows,
  PAY_METHODS,
  type PayMethod,
  type PayRow,
  SaleInvalidError,
  settle,
  udhaarCheck,
  WALLET_PROVIDERS,
} from '../data/sale.ts';
import { ReadOnlyError } from '../data/write.ts';
import { formatShopMoney } from '../lib/money';
import { useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { Modal } from './Modal.tsx';

const SaleComplete = lazy(() =>
  import('./SaleComplete.tsx').then((m) => ({ default: m.SaleComplete })),
);

import { CustomerDialog } from './SellDialogs.tsx';
import { mutateCart, useCustomer } from './useSell.ts';

const METHOD_KEY: Record<PayMethod, string> = {
  cash: 'payment.cash',
  bank_wallet: 'payment.bank_wallet',
  card: 'payment.card',
  udhaar: 'payment.udhaar',
};

const METHOD_ICON: Record<PayMethod, () => React.JSX.Element> = {
  cash: CashIcon,
  bank_wallet: BankIcon,
  card: CardIcon,
  udhaar: UdhaarIcon,
};

const METHOD_HINT: Record<PayMethod, string> = {
  cash: 'pay.method_cash_hint',
  bank_wallet: 'pay.method_bank_hint',
  card: 'pay.method_card_hint',
  udhaar: 'pay.method_udhaar_hint',
};

export type Done = {
  sale: SyncedRow;
  customerName: string;
  /** Customer's phone for the WhatsApp share (screens/07). */
  customerPhone: string | null;
  balance: number;
  print: boolean;
  whatsapp: boolean;
};

/** Take payment (screens/06) → Sale complete (screens/07), two steps of one modal. */
export function PayDialog({
  open,
  onOpenChange,
  cartId,
  cart,
  totals,
  money,
  requestOverride,
  onScan,
  onOpenBill,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cartId: CartId;
  cart: Cart;
  totals: CartResult;
  money: ShopMoney;
  requestOverride: (
    permission: 'udhaar.hard_limit',
    onApproved: (by: string) => void,
  ) => void;
  /** A barcode scanned on Sale complete starts the next sale (screens/07 AC 1). */
  onScan: (code: string) => void;
  onOpenBill: (saleId: string) => void;
}) {
  const { t } = useTranslation();
  const [done, setDone] = useState<Done | null>(null);
  useEffect(() => {
    if (open) setDone(null);
  }, [open]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      full
      title={done ? t('pay.done_title') : t('sell.take_payment')}
      header={
        done ? null : (
          <Box ta="end">
            <Text size="sm" c="dimmed">
              {t('sell.total_to_pay')}
            </Text>
            <Text
              fz={{ base: 20, sm: 28 }}
              fw={600}
              style={{ whiteSpace: 'nowrap' }}
              data-testid="pay-total"
            >
              <MoneyText paisa={totals.total} />
            </Text>
          </Box>
        )
      }
    >
      {done ? (
        <Suspense
          fallback={<Text className="sr-only">{t('common.loading')}</Text>}
        >
          <SaleComplete
            done={done}
            onNewSale={() => onOpenChange(false)}
            onScan={onScan}
            onOpenBill={() => onOpenBill(String(done.sale.id))}
          />
        </Suspense>
      ) : open ? (
        <PayStep
          cartId={cartId}
          cart={cart}
          totals={totals}
          money={money}
          requestOverride={requestOverride}
          onSaved={setDone}
        />
      ) : null}
    </Modal>
  );
}

function PayStep({
  cartId,
  cart,
  totals,
  money,
  requestOverride,
  onSaved,
}: {
  cartId: CartId;
  cart: Cart;
  totals: CartResult;
  money: ShopMoney;
  requestOverride: (
    permission: 'udhaar.hard_limit',
    onApproved: (by: string) => void,
  ) => void;
  onSaved: (done: Done) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const saleId = useMemo(() => newId(), []);
  const total = totals.total;
  const [rows, setRows] = useState<PayRow[]>([
    { method: 'cash', amount: total },
  ]);
  const [activeRow, setActiveRow] = useState(0);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [picker, setPicker] = useState(false);
  const printer = useLiveQuery(
    async () =>
      ((await getDb().kv.get('printer'))?.value ?? null) as {
        auto_print?: boolean;
      } | null,
    [],
  );
  const [print, setPrint] = useState<boolean | null>(null);
  const [whatsapp, setWhatsapp] = useState(false);
  const printOn = print ?? (printer ? printer.auto_print !== false : false);
  const customer = useCustomer(cart.customer_id);
  const noteId = useId();
  const merged = mergeRows(rows);
  const s = settle(total, merged);
  const credit = useLiveQuery(
    async () =>
      cart.customer_id && s.udhaar > 0
        ? udhaarCheck(getDb(), cart.customer_id, s.udhaar)
        : null,
    [cart.customer_id, s.udhaar],
  );
  const hardBlocked =
    Boolean(credit?.hard_blocked) && !hasOverride(cart, 'udhaar.hard_limit');
  const needsCustomer = s.udhaar > 0 && !cart.customer_id;
  const udhaarDenied = s.udhaar > 0 && !can('sale.udhaar');
  const valid = s.valid && !needsCustomer && !hardBlocked && !udhaarDenied;
  const row = rows[activeRow] ?? rows[0];
  const othersApplied = (index: number) =>
    rows.reduce((sum, r, i) => (i === index ? sum : sum + r.amount), 0);
  const dueFor = (index: number) => Math.max(0, total - othersApplied(index));

  const setRow = (index: number, patch: Partial<PayRow>) =>
    setRows((list) =>
      list.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  const chooseMethod = (method: PayMethod) =>
    setRow(activeRow, { method, amount: dueFor(activeRow) });
  const addSplit = () => {
    const used = new Set(rows.map((r) => r.method));
    const method = PAY_METHODS.find((m) => !used.has(m)) ?? 'cash';
    setRows((list) => [
      ...list,
      {
        method,
        amount: Math.max(0, total - list.reduce((n, r) => n + r.amount, 0)),
      },
    ]);
    setActiveRow(rows.length);
  };
  const removeRow = (index: number) => {
    setRows((list) => list.filter((_, i) => i !== index));
    setActiveRow(0);
  };

  const submitted = useRef(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || pending || submitted.current) return;
    submitted.current = true;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      const { sale } = await completeSale(
        db,
        {
          saleId,
          cartId,
          cart,
          money,
          rows: merged,
          note,
          print: printOn,
          maxDiscountBp:
            staff?.role === 'owner'
              ? 10000
              : Number(staff?.max_discount_bp ?? 0),
        },
        ctx,
      );
      const after = cart.customer_id
        ? ((await db.party_balances.get(['customer', cart.customer_id]))
            ?.balance ?? 0)
        : 0;
      onSaved({
        sale,
        customerName: customer ? String(customer.customer.name) : '',
        customerPhone: customer?.customer.phone
          ? String(customer.customer.phone)
          : null,
        balance: after,
        print: printOn,
        whatsapp,
      });
    } catch (err) {
      submitted.current = false;
      toast.push(
        err instanceof ReadOnlyError
          ? t('tenant.readOnly.blocked')
          : err instanceof SaleInvalidError &&
              err.message.includes('cart already paid')
            ? t('pay.cart_changed')
            : t('pay.save_failed'),
        'error',
      );
    } finally {
      setPending(false);
    }
  };

  useHotkey(
    (ev) => /^[1-4]$/u.test(ev.key) && !ev.ctrlKey && !ev.altKey && !ev.metaKey,
    (ev) => chooseMethod(PAY_METHODS[Number(ev.key) - 1] as PayMethod),
  );
  useHotkey(
    (ev) => ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey),
    addSplit,
    { inFields: true },
  );

  const label =
    s.udhaar > 0 && s.paidTotal === 0
      ? t('pay.write_khata', { amount: formatShopMoney(s.udhaar) })
      : s.udhaar > 0
        ? t('pay.done_mixed', {
            paid: formatShopMoney(s.paidTotal),
            udhaar: formatShopMoney(s.udhaar),
          })
        : t('pay.done_paid', { amount: formatShopMoney(total) });

  return (
    <Box component="form" onSubmit={(e: FormEvent) => void submit(e)}>
      <Stack gap="md">
        <SimpleGrid
          cols={2}
          spacing="sm"
          role="tablist"
          aria-label={t('pay.method')}
        >
          {PAY_METHODS.map((m) => {
            const Icon = METHOD_ICON[m];
            const active = row?.method === m;
            return (
              <Button
                key={m}
                type="button"
                role="tab"
                aria-selected={active}
                variant={active ? 'light' : 'default'}
                h="auto"
                p="sm"
                justify="flex-start"
                styles={{ label: { width: '100%' } }}
                onClick={() => chooseMethod(m)}
              >
                <Group gap="sm" wrap="nowrap" w="100%">
                  <Box
                    w={36}
                    h={36}
                    style={{
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 8,
                      background: active
                        ? 'var(--mantine-color-body)'
                        : 'var(--mantine-color-default-hover)',
                    }}
                  >
                    <Icon />
                  </Box>
                  <Box style={{ minWidth: 0, flex: 1, textAlign: 'start' }}>
                    <Text size="sm" fw={500}>
                      {t(METHOD_KEY[m])}
                    </Text>
                    <Text size="xs" c={active ? undefined : 'dimmed'}>
                      {t(METHOD_HINT[m])}
                    </Text>
                  </Box>
                  {active ? (
                    <Text aria-hidden="true" fz="lg">
                      ✓
                    </Text>
                  ) : null}
                </Group>
              </Button>
            );
          })}
        </SimpleGrid>

        {row ? (
          <MethodPanel
            key={`${activeRow}-${row.method}`}
            row={row}
            due={dueFor(activeRow)}
            change={s.change}
            remaining={s.remaining}
            onChange={(patch) => setRow(activeRow, patch)}
            customer={customer}
            credit={credit ?? null}
            hardBlocked={hardBlocked}
            onPickCustomer={() => setPicker(true)}
            onOverride={() =>
              requestOverride('udhaar.hard_limit', (by) => {
                void mutateCart(cartId, (c) =>
                  addOverride(c, {
                    permission: 'udhaar.hard_limit',
                    approved_by: by,
                  }),
                );
              })
            }
          />
        ) : null}

        <Stack gap="xs">
          {rows.length > 1 ? (
            <Box
              component="ul"
              aria-label={t('pay.split_list')}
              style={{ listStyle: 'none', margin: 0, padding: 0 }}
            >
              {rows.map((r, i) => (
                <Paper
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity; position is what the cashier edits
                  key={`${i}-${r.method}`}
                  withBorder
                  p="xs"
                  mt={4}
                  data-testid="pay-row"
                  style={{
                    borderColor:
                      i === activeRow
                        ? 'var(--mantine-color-brand-6)'
                        : undefined,
                  }}
                >
                  <Group gap="sm" wrap="nowrap">
                    <Button
                      type="button"
                      variant="transparent"
                      size="compact-sm"
                      justify="flex-start"
                      style={{ flex: 1 }}
                      onClick={() => setActiveRow(i)}
                    >
                      {t(METHOD_KEY[r.method])} · <MoneyText paisa={r.amount} />
                    </Button>
                    <Button
                      type="button"
                      variant="transparent"
                      color="danger"
                      size="compact-sm"
                      onClick={() => removeRow(i)}
                    >
                      {t('pay.remove')}
                    </Button>
                  </Group>
                </Paper>
              ))}
            </Box>
          ) : null}
          <Group justify="space-between" gap="sm" wrap="wrap">
            <Button
              type="button"
              variant="default"
              size="compact-sm"
              onClick={addSplit}
              disabled={rows.length >= 4}
            >
              {t('pay.split')}
            </Button>
            <Text size="sm" data-testid="pay-running" aria-live="polite">
              {t('pay.running', {
                paid: formatShopMoney(s.paidTotal + s.udhaar),
                remaining: formatShopMoney(s.remaining),
              })}
            </Text>
          </Group>
          {s.overpaid ? (
            <Text c="danger" role="alert" size="sm">
              {t('pay.overpaid')}
            </Text>
          ) : null}
          {needsCustomer ? (
            <Text c="danger" role="alert" size="sm">
              {t('pay.need_customer')}
            </Text>
          ) : null}
          {udhaarDenied ? (
            <Text c="danger" role="alert" size="sm">
              {t('pay.no_udhaar')}
            </Text>
          ) : null}
        </Stack>

        <Stack gap="xs">
          <Checkbox
            label={t('pay.print')}
            checked={printOn}
            onChange={(event) => setPrint(event.currentTarget.checked)}
          />
          {customer?.customer.phone ? (
            <Checkbox
              label={t('pay.whatsapp')}
              checked={whatsapp}
              onChange={(event) => setWhatsapp(event.currentTarget.checked)}
            />
          ) : null}
          <TextInput
            id={noteId}
            label={t('pay.note')}
            maxLength={120}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </Stack>

        <Button
          type="submit"
          size="lg"
          fullWidth
          disabled={!valid || pending}
          loading={pending}
          data-testid="pay-done"
        >
          {label}
        </Button>
      </Stack>

      <CustomerDialog
        open={picker}
        onOpenChange={setPicker}
        onPick={(id) =>
          void mutateCart(cartId, (c) => ({ ...c, customer_id: id }))
        }
        actor={staff?.id ?? null}
        canCreate={can('party.edit')}
      />
    </Box>
  );
}

function MethodPanel({
  row,
  due,
  change,
  remaining,
  onChange,
  customer,
  credit,
  hardBlocked,
  onPickCustomer,
  onOverride,
}: {
  row: PayRow;
  due: number;
  change: number;
  remaining: number;
  onChange: (patch: Partial<PayRow>) => void;
  customer: ReturnType<typeof useCustomer>;
  credit: Awaited<ReturnType<typeof udhaarCheck>> | null;
  hardBlocked: boolean;
  onPickCustomer: () => void;
  onOverride: () => void;
}) {
  const { t } = useTranslation();
  const refId = useId();
  const last4Id = useId();
  const received = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The cashier types the received amount straight away (prefilled, all selected).
    received.current?.querySelector('input')?.select();
  }, []);
  const amountInput = (label: string, large = false, autoFocus = false) => (
    <MoneyInput
      label={label}
      large={large}
      autoFocus={autoFocus}
      value={row.amount}
      onChange={(v) => onChange({ amount: v ?? 0 })}
    />
  );
  if (row.method === 'cash') {
    return (
      <Stack gap="sm">
        <Box ref={received}>{amountInput(t('pay.received'), true, true)}</Box>
        <Group gap="xs">
          {[due, ...cashChips(due)].map((v, i) => (
            <Button
              key={v}
              type="button"
              variant="default"
              size="compact-sm"
              onClick={() => onChange({ amount: v })}
            >
              {i === 0 ? t('pay.exact') : <MoneyText paisa={v} />}
            </Button>
          ))}
        </Group>
        <SimpleGrid cols={2} spacing="sm">
          <Paper p="sm" bg="var(--mantine-color-default-hover)">
            <Text size="sm" c="dimmed">
              {t('pay.change_label')}
            </Text>
            {change > 0 ? (
              <Text
                fz={20}
                fw={600}
                c="var(--color-success)"
                data-testid="pay-change"
                aria-live="polite"
              >
                <MoneyText paisa={change} />
              </Text>
            ) : (
              <Text fz={20} fw={600}>
                —
              </Text>
            )}
          </Paper>
          <Paper p="sm" bg="var(--mantine-color-default-hover)">
            <Text size="sm" c="dimmed">
              {t('pay.due_label')}
            </Text>
            {remaining > 0 ? (
              <Text
                fz={20}
                fw={600}
                c="var(--color-warning)"
                data-testid="pay-due"
                aria-live="polite"
              >
                <MoneyText paisa={remaining} />
              </Text>
            ) : (
              <Text fz={20} fw={600}>
                —
              </Text>
            )}
          </Paper>
        </SimpleGrid>
      </Stack>
    );
  }
  if (row.method === 'bank_wallet') {
    return (
      <Stack gap="sm">
        <Group gap="xs" role="group" aria-label={t('pay.provider')}>
          {WALLET_PROVIDERS.map((p) => (
            <Button
              key={p}
              type="button"
              size="compact-sm"
              radius="xl"
              variant={row.provider === p ? 'filled' : 'default'}
              aria-pressed={row.provider === p}
              onClick={() => onChange({ provider: p })}
            >
              {t(`pay.provider_${p.toLowerCase().replace(' ', '_')}`)}
            </Button>
          ))}
        </Group>
        <TextInput
          id={refId}
          label={t('pay.reference')}
          maxLength={40}
          value={row.reference ?? ''}
          onChange={(event) =>
            onChange({ reference: event.currentTarget.value })
          }
        />
        {amountInput(t('pay.amount'))}
      </Stack>
    );
  }
  if (row.method === 'card') {
    return (
      <Stack gap="sm">
        <TextInput
          id={last4Id}
          label={t('pay.last4')}
          inputMode="numeric"
          dir="ltr"
          maxLength={4}
          value={row.last4 ?? ''}
          onChange={(event) =>
            onChange({ last4: event.currentTarget.value.replace(/\D/gu, '') })
          }
        />
        <TextInput
          id={refId}
          label={t('pay.reference')}
          maxLength={40}
          value={row.reference ?? ''}
          onChange={(event) =>
            onChange({ reference: event.currentTarget.value })
          }
        />
        {amountInput(t('pay.amount'))}
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <Paper withBorder p="sm">
        <Group justify="space-between" gap="sm" wrap="nowrap">
          <Text size="sm" data-testid="pay-customer">
            {customer ? String(customer.customer.name) : t('pay.no_customer')}
          </Text>
          <Button
            type="button"
            variant="transparent"
            size="compact-sm"
            onClick={onPickCustomer}
          >
            {customer ? t('sell.change_customer') : t('pay.choose_customer')}
          </Button>
        </Group>
      </Paper>
      {credit ? (
        <Box data-testid="pay-credit">
          <Text
            size="sm"
            c={
              credit.over_limit
                ? 'var(--color-warning)'
                : 'var(--mantine-color-dimmed)'
            }
          >
            {t('pay.credit_line', {
              owes: formatShopMoney(credit.balance),
              after: formatShopMoney(credit.balance_after),
            })}
            {credit.limit !== null
              ? ` · ${t('pay.credit_limit', {
                  limit: formatShopMoney(credit.limit),
                })}`
              : ''}
          </Text>
          {credit.over_limit ? (
            <Text size="sm" fw={500} c="var(--color-warning)" role="status">
              {t('pay.over_limit', {
                over: formatShopMoney(credit.over_by),
                limit: formatShopMoney(credit.limit ?? 0),
              })}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {hardBlocked ? (
        <Button
          type="button"
          variant="transparent"
          size="compact-sm"
          px={0}
          onClick={onOverride}
          style={{ alignSelf: 'flex-start' }}
        >
          {t('pay.manager_override')}
        </Button>
      ) : null}
      {amountInput(t('pay.amount'))}
    </Stack>
  );
}
