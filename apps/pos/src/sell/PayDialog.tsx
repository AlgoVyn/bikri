import { type CartResult, cashChips, newId } from '@bikri/core';
import type { Cart, SyncedRow } from '@bikri/db';
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
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
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
          <div className="text-end">
            <p className="text-small text-text-muted">
              {t('sell.total_to_pay')}
            </p>
            <p
              className="text-total font-semibold whitespace-nowrap max-sm:text-title"
              data-testid="pay-total"
            >
              <MoneyText paisa={totals.total} />
            </p>
          </div>
        )
      }
    >
      {done ? (
        <Suspense fallback={<p className="sr-only">{t('common.loading')}</p>}>
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
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <div
        role="tablist"
        aria-label={t('pay.method')}
        className="grid grid-cols-2 gap-2"
      >
        {PAY_METHODS.map((m) => {
          const Icon = METHOD_ICON[m];
          const active = row?.method === m;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={active}
              className={`flex min-h-20 items-center gap-2 rounded-control border p-3 text-start ${
                active
                  ? 'border-primary bg-primary-subtle text-primary-subtle-ink'
                  : 'border-border bg-surface text-text-muted hover:bg-surface-2'
              }`}
              onClick={() => chooseMethod(m)}
            >
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-control ${
                  active
                    ? 'bg-surface text-primary'
                    : 'bg-surface-2 text-text-muted'
                }`}
              >
                <Icon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-small font-medium">
                  {t(METHOD_KEY[m])}
                </span>
                <span
                  className={`block text-small ${active ? 'text-primary-subtle-ink' : 'text-text-muted'}`}
                >
                  {t(METHOD_HINT[m])}
                </span>
              </span>
              {active ? (
                <span
                  aria-hidden="true"
                  className="text-title text-primary-subtle-ink"
                >
                  ✓
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

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

      <div className="flex flex-col gap-2">
        {rows.length > 1 ? (
          <ul aria-label={t('pay.split_list')} className="flex flex-col gap-1">
            {rows.map((r, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity; position is what the cashier edits
                key={`${i}-${r.method}`}
                data-testid="pay-row"
                className={`flex items-center gap-2 rounded-control border px-2 ${i === activeRow ? 'border-primary' : 'border-border'}`}
              >
                <button
                  type="button"
                  className="min-h-11 flex-1 text-start"
                  onClick={() => setActiveRow(i)}
                >
                  {t(METHOD_KEY[r.method])} · <MoneyText paisa={r.amount} />
                </button>
                <button
                  type="button"
                  className="min-h-11 px-2 text-danger"
                  onClick={() => removeRow(i)}
                >
                  {t('pay.remove')}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            className={buttonQuiet}
            onClick={addSplit}
            disabled={rows.length >= 4}
          >
            {t('pay.split')}
          </button>
          <p data-testid="pay-running" aria-live="polite">
            {t('pay.running', {
              paid: formatShopMoney(s.paidTotal + s.udhaar),
              remaining: formatShopMoney(s.remaining),
            })}
          </p>
        </div>
        {s.overpaid ? (
          <p className="text-danger" role="alert">
            {t('pay.overpaid')}
          </p>
        ) : null}
        {needsCustomer ? (
          <p className="text-danger" role="alert">
            {t('pay.need_customer')}
          </p>
        ) : null}
        {udhaarDenied ? (
          <p className="text-danger" role="alert">
            {t('pay.no_udhaar')}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            className="size-5"
            checked={printOn}
            onChange={(e) => setPrint(e.target.checked)}
          />
          {t('pay.print')}
        </label>
        {customer?.customer.phone ? (
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              className="size-5"
              checked={whatsapp}
              onChange={(e) => setWhatsapp(e.target.checked)}
            />
            {t('pay.whatsapp')}
          </label>
        ) : null}
        <div>
          <label htmlFor={noteId} className="mb-1 block text-small">
            {t('pay.note')}
          </label>
          <input
            id={noteId}
            className={fieldClass}
            maxLength={120}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>

      <button
        type="submit"
        className={`${buttonPrimary} min-h-14 text-title`}
        disabled={!valid || pending}
        data-testid="pay-done"
      >
        {label}
      </button>
      <CustomerDialog
        open={picker}
        onOpenChange={setPicker}
        onPick={(id) =>
          void mutateCart(cartId, (c) => ({ ...c, customer_id: id }))
        }
        actor={staff?.id ?? null}
        canCreate={can('party.edit')}
      />
    </form>
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
  const amountInput = (label: string, large = false) => (
    <MoneyInput
      label={label}
      large={large}
      value={row.amount}
      onChange={(v) => onChange({ amount: v ?? 0 })}
    />
  );
  if (row.method === 'cash') {
    return (
      <div className="flex flex-col gap-2">
        <div ref={received}>{amountInput(t('pay.received'), true)}</div>
        <div className="flex flex-wrap gap-2">
          {[due, ...cashChips(due)].map((v, i) => (
            <button
              key={v}
              type="button"
              className={buttonQuiet}
              onClick={() => onChange({ amount: v })}
            >
              {i === 0 ? t('pay.exact') : <MoneyText paisa={v} />}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-control border border-border bg-surface-2 p-2">
            <p className="text-small text-text-muted">
              {t('pay.change_label')}
            </p>
            {change > 0 ? (
              <p
                className="text-title font-semibold text-success"
                data-testid="pay-change"
                aria-live="polite"
              >
                <MoneyText paisa={change} />
              </p>
            ) : (
              <p className="text-title font-semibold">—</p>
            )}
          </div>
          <div className="rounded-control border border-border bg-surface-2 p-2">
            <p className="text-small text-text-muted">{t('pay.due_label')}</p>
            {remaining > 0 ? (
              <p
                className="text-title font-semibold text-warning"
                data-testid="pay-due"
                aria-live="polite"
              >
                <MoneyText paisa={remaining} />
              </p>
            ) : (
              <p className="text-title font-semibold">—</p>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (row.method === 'bank_wallet') {
    return (
      <div className="flex flex-col gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: provider chips */}
        <div
          role="group"
          aria-label={t('pay.provider')}
          className="flex flex-wrap gap-2"
        >
          {WALLET_PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={row.provider === p}
              className={`min-h-11 rounded-full border px-3 ${row.provider === p ? 'border-primary bg-primary text-primary-ink' : 'border-border'}`}
              onClick={() => onChange({ provider: p })}
            >
              {t(`pay.provider_${p.toLowerCase().replace(' ', '_')}`)}
            </button>
          ))}
        </div>
        <div>
          <label htmlFor={refId} className="mb-1 block text-small">
            {t('pay.reference')}
          </label>
          <input
            id={refId}
            className={fieldClass}
            maxLength={40}
            value={row.reference ?? ''}
            onChange={(e) => onChange({ reference: e.target.value })}
          />
        </div>
        {amountInput(t('pay.amount'))}
      </div>
    );
  }
  if (row.method === 'card') {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <label htmlFor={last4Id} className="mb-1 block text-small">
            {t('pay.last4')}
          </label>
          <input
            id={last4Id}
            inputMode="numeric"
            dir="ltr"
            className={fieldClass}
            maxLength={4}
            value={row.last4 ?? ''}
            onChange={(e) =>
              onChange({ last4: e.target.value.replace(/\D/gu, '') })
            }
          />
        </div>
        <div>
          <label htmlFor={refId} className="mb-1 block text-small">
            {t('pay.reference')}
          </label>
          <input
            id={refId}
            className={fieldClass}
            maxLength={40}
            value={row.reference ?? ''}
            onChange={(e) => onChange({ reference: e.target.value })}
          />
        </div>
        {amountInput(t('pay.amount'))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-11 items-center justify-between gap-2 rounded-control border border-border px-3">
        <span data-testid="pay-customer">
          {customer ? String(customer.customer.name) : t('pay.no_customer')}
        </span>
        <button
          type="button"
          className="min-h-11 px-2 text-primary"
          onClick={onPickCustomer}
        >
          {customer ? t('sell.change_customer') : t('pay.choose_customer')}
        </button>
      </div>
      {credit ? (
        <p
          data-testid="pay-credit"
          className={credit.over_limit ? 'text-warning' : 'text-text-muted'}
        >
          {t('pay.credit_line', {
            owes: formatShopMoney(credit.balance),
            after: formatShopMoney(credit.balance_after),
          })}
          {credit.limit !== null
            ? ` · ${t('pay.credit_limit', { limit: formatShopMoney(credit.limit) })}`
            : ''}
          {credit.over_limit ? (
            <span className="block font-medium" role="status">
              {t('pay.over_limit', {
                over: formatShopMoney(credit.over_by),
                limit: formatShopMoney(credit.limit ?? 0),
              })}
            </span>
          ) : null}
        </p>
      ) : null}
      {hardBlocked ? (
        <button
          type="button"
          className="self-start text-primary underline"
          onClick={onOverride}
        >
          {t('pay.manager_override')}
        </button>
      ) : null}
      {amountInput(t('pay.amount'))}
    </div>
  );
}
