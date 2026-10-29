import {
  can as canDo,
  type Permission,
  type Role,
  verifyPin,
} from '@bikri/core';
import type { Cart, CartLine, HeldBill, MasterRow } from '@bikri/db';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { ProductsIcon, SearchIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { OverrideDialog } from '../components/OverrideDialog.tsx';
import { isRapidBarcode } from '../components/SearchBox.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  addOverride,
  addProduct,
  addQuickSale,
  approversFor,
  CART_IDS,
  CartFullError,
  type CartId,
  CartNotEmptyError,
  cartTotals,
  deleteHeld,
  emptyCart,
  findByCode,
  hasOverride,
  holdCart,
  isEmptyCart,
  parseQtyPrefix,
  paymentChecks,
  removeLine,
  resumeHeld,
  updateLine,
} from '../data/cart.ts';
import { getDb } from '../data/db.ts';
import { deviceInfo } from '../data/localTenant.ts';
import { useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { beep } from './beep.ts';
import { CartPanel } from './CartPanel.tsx';
import { PayDialog } from './PayDialog.tsx';
import { ProductGrid } from './ProductGrid.tsx';
import {
  BillDiscountDialog,
  CustomerDialog,
  HeldBillsDialog,
  HoldDialog,
  QuickSaleDialog,
  timeOf,
} from './SellDialogs.tsx';
import { useSellStore } from './sellStore.ts';
import {
  cartsSettled,
  filterRows,
  mutateCart,
  type SellRow,
  useCarts,
  useSellProducts,
  useShopMoney,
} from './useSell.ts';

type OverridePermission = Permission | 'udhaar.hard_limit';
type OverrideRequest = {
  permission: OverridePermission;
  onApproved: (approvedBy: string) => void;
};

const fKey = (key: string) => (e: KeyboardEvent) =>
  e.key === key && !e.altKey && !e.ctrlKey && !e.metaKey;

/** Sell (screens/05). */
export function SellPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const { staff, can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const money = useShopMoney();
  const rows = useSellProducts();
  const carts = useCarts();
  const device = useLiveQuery(() => deviceInfo(getDb()), []);
  const heldCount = useLiveQuery(() => getDb().held_bills.count(), []) ?? 0;
  const allStaff = useLiveQuery(() => getDb().staff.toArray(), []) ?? [];
  const active = useSellStore((s) => s.active);
  const setActive = useSellStore((s) => s.setActive);
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const [nextQty, setNextQty] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [dialog, setDialog] = useState<
    null | 'quick' | 'discount' | 'hold' | 'held' | 'customer' | 'clear' | 'pay'
  >(null);
  const [quickName, setQuickName] = useState('');
  const [override, setOverride] = useState<OverrideRequest | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stamps = useRef<number[]>([]);

  const cart: Cart = carts?.[active] ?? emptyCart(active, 0);
  const totals = useMemo(() => cartTotals(cart, money), [cart, money]);
  const cartQty = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of cart.lines)
      if (line.product_id)
        map.set(
          line.product_id,
          (map.get(line.product_id) ?? 0) + line.qty_milli,
        );
    return map;
  }, [cart.lines]);
  const prefix = parseQtyPrefix(query);
  const term = prefix ? prefix.rest : query;
  const results = useMemo(() => {
    const found = rows ? filterRows(rows, term) : [];
    return categoryId && !term.trim()
      ? found.filter((r) => r.product.category_id === categoryId)
      : found;
  }, [rows, term, categoryId]);
  const stock = useMemo(
    () => new Map((rows ?? []).map((r) => [r.product.id, r.onHand])),
    [rows],
  );
  const searching = term.trim() !== '';

  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  useEffect(() => {
    setHighlight(searching && results.length > 0 ? 0 : -1);
  }, [searching, results.length]);

  const mutate = (fn: (c: Cart) => Cart) =>
    mutateCart(active, fn).catch((err: unknown) => {
      if (err instanceof CartFullError)
        toast.push(t('sell.cart_full'), 'error');
      else throw err;
    });

  const focusSearch = () => searchRef.current?.focus();

  const add = (product: MasterRow, qty?: number) => {
    const qtyMilli = qty ?? nextQty ?? 1000;
    setNextQty(null);
    beep();
    void mutate((c) => addProduct(c, product, qtyMilli, money.cost_method));
    focusSearch();
  };

  const addRow = (row: SellRow) => {
    add(row.product);
    setQuery('');
  };

  const unknownBarcode = (code: string) => {
    toast.push(t('sell.unknown_barcode', { code }), 'error', [
      ...(can('catalog.edit')
        ? [
            {
              label: t('sell.add_product'),
              onClick: () =>
                void navigate({
                  to: '/products/new',
                  search: { barcode: code },
                }),
            },
          ]
        : []),
      {
        label: t('sell.quick_sale'),
        onClick: () => {
          setQuickName('');
          setDialog('quick');
        },
      },
    ]);
  };

  /** Clears the search only if it still holds what Enter submitted (a scanner may already be typing the next code). */
  const consumed = (value: string) => setQuery((q) => (q === value ? '' : q));

  const onEnter = async (value: string, rapid: boolean) => {
    const parsed = parseQtyPrefix(value);
    const code = (parsed ? parsed.rest : value).trim();
    const qty = parsed?.qtyMilli;
    if (parsed && !code) {
      setNextQty(parsed.qtyMilli);
      consumed(value);
      return;
    }
    if (!code) {
      takePayment();
      return;
    }
    const byCode = await findByCode(getDb(), code);
    if (byCode) {
      consumed(value);
      add(byCode, qty);
      return;
    }
    const list = rows ? filterRows(rows, code) : [];
    const pick =
      list.length === 1
        ? list[0]
        : highlight >= 0
          ? list[highlight]
          : undefined;
    if (pick && !rapid) {
      consumed(value);
      add(pick.product, qty);
      return;
    }
    if (rapid || /^\d{6,}$/u.test(code)) {
      consumed(value);
      unknownBarcode(code);
    }
  };

  // --- overrides (05 §4.1) ---
  const approvers = (permission: OverridePermission) =>
    approversFor(allStaff, (s) => {
      if (permission === 'udhaar.hard_limit')
        return (
          s.id !== staff?.id && (s.role === 'owner' || s.role === 'manager')
        );
      if (s.id === staff?.id) return false;
      const ok = canDo(
        s.role as Role,
        String(s.permissions_json ?? '{}'),
        permission,
      );
      if (permission !== 'sale.discount') return ok;
      return (
        ok &&
        (s.role === 'owner' ||
          Number(s.max_discount_bp ?? 0) >= totals.discount_share_bp)
      );
    });

  const verify = async (pin: string, profileId: string) => {
    const s = allStaff.find((x) => x.id === profileId);
    if (!s || !override) return false;
    const ok = await verifyPin(pin, {
      pin_hash: String(s.pin_hash),
      pin_salt: String(s.pin_salt),
      pin_iterations: Number(s.pin_iterations),
    });
    if (ok) {
      const request = override;
      setTimeout(() => request.onApproved(s.id), 0);
    }
    return ok;
  };

  const takePayment = async () => {
    if (readOnly) {
      toast.push(t('tenant.readOnly.blocked'), 'error');
      return;
    }
    await cartsSettled();
    const current = (await getDb().carts.get(active)) ?? cart;
    if (current.lines.length === 0) return;
    const now = cartTotals(current, money);
    const checks = paymentChecks(current, now, {
      maxDiscountBp:
        staff?.role === 'owner' ? 10000 : Number(staff?.max_discount_bp ?? 0),
      canBelowCost: can('sale.below_cost'),
      canDiscount: can('sale.discount'),
    });
    const voidNeeded =
      current.reissue != null &&
      !can('sale.void') &&
      !hasOverride(current, 'sale.void');
    const need: OverridePermission | null = checks.belowCost
      ? 'sale.below_cost'
      : checks.discount
        ? 'sale.discount'
        : voidNeeded
          ? 'sale.void'
          : null;
    if (need) {
      setOverride({
        permission: need,
        onApproved: (by) => {
          void mutate((c) =>
            addOverride(c, { permission: need, approved_by: by }),
          ).then(() => takePayment());
        },
      });
      return;
    }
    setDialog('pay');
  };

  const onPriceChange = (line: CartLine, price: number) => {
    const apply = () =>
      void mutate((c) => updateLine(c, line.key, { unit_price: price }));
    if (price < (line.list_price ?? line.unit_price) && !can('catalog.edit')) {
      setOverride({ permission: 'catalog.edit', onApproved: apply });
      return;
    }
    apply();
  };

  const clearCart = () => {
    void mutate((c) => emptyCart(c.id as CartId));
    setSelected(null);
    setExpanded(null);
    focusSearch();
  };

  const askClear = () => {
    if (cart.lines.length > 0) setDialog('clear');
    else clearCart();
  };

  const customerName = useLiveQuery(
    async () =>
      cart.customer_id
        ? String((await getDb().customers.get(cart.customer_id))?.name ?? '')
        : '',
    [cart.customer_id],
  );
  const reissueInvoice = useLiveQuery(
    async () =>
      cart.reissue
        ? String(
            (await getDb().sales.get(cart.reissue.sale_id))?.invoice_no ?? '',
          )
        : '',
    [cart.reissue?.sale_id],
  );
  const holdLabel =
    customerName ||
    t('sell.held_default', { time: timeOf(Date.now(), i18n.language) });

  const onHold = async (label: string) => {
    await cartsSettled();
    const current = (await getDb().carts.get(active)) ?? cart;
    await holdCart(getDb(), current, { label, staffId: staff?.id ?? '' });
    toast.push(t('sell.held_done', { label }));
    focusSearch();
  };

  const onResume = async (held: HeldBill, into: CartId | null) => {
    const target = into ?? active;
    try {
      await cartsSettled();
      await resumeHeld(getDb(), held.id, target);
      setActive(target);
      setDialog(null);
    } catch (err) {
      if (err instanceof CartNotEmptyError)
        toast.push(t('sell.no_free_cart'), 'error');
      else throw err;
    }
  };

  const tab = (id: CartId) => {
    setActive(id);
    setSelected(null);
    setExpanded(null);
  };

  // --- hotkeys (screens/05) ---
  const ready = dialog === null && override === null;
  useHotkey(
    (e) =>
      e.key === 'F2' ||
      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f'),
    focusSearch,
    { inFields: true, enabled: ready },
  );
  useHotkey(
    (e) => e.ctrlKey && !e.altKey && /^[123]$/u.test(e.key),
    (e) => tab(CART_IDS[Number(e.key) - 1] as CartId),
    { inFields: true, enabled: ready },
  );
  useHotkey(fKey('F3'), () => cart.lines.length > 0 && setDialog('discount'), {
    inFields: true,
    enabled: ready,
  });
  useHotkey(
    (e) => e.key === 'F4' || (e.ctrlKey && e.key.toLowerCase() === 'h'),
    () => cart.lines.length > 0 && setDialog('hold'),
    {
      inFields: true,
      enabled: ready,
    },
  );
  useHotkey(fKey('F6'), () => setDialog('held'), {
    inFields: true,
    enabled: ready,
  });
  useHotkey(
    fKey('F7'),
    () => {
      setQuickName('');
      setDialog('quick');
    },
    { inFields: true, enabled: ready },
  );
  useHotkey(
    fKey('F9'),
    () => {
      if (!can('drawer.open')) {
        toast.push(t('sell.drawer_denied'), 'error');
        return;
      }
      void (async () => {
        const [{ errorCode, openDrawer }, { browserPrintDeps }] =
          await Promise.all([
            import('../print/printService.ts'),
            import('../print/printDeps.ts'),
          ]);
        try {
          await openDrawer(getDb(), browserPrintDeps(), staff?.id ?? null);
          toast.push(t('printer.drawer_opened'), 'info');
        } catch (err) {
          toast.push(t(`print.err_${errorCode(err)}`), 'error');
        }
      })();
    },
    { inFields: true, enabled: ready },
  );
  useHotkey(fKey('F8'), () => void takePayment(), {
    inFields: true,
    enabled: ready,
  });
  useHotkey(
    (e) =>
      (e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.altKey && !e.metaKey,
    () => (cart.lines.length > 0 ? setDialog('clear') : focusSearch()),
    { enabled: ready },
  );
  useHotkey(
    (e) => e.key === 'Escape',
    () => {
      if (expanded) setExpanded(null);
      else askClear();
    },
    { enabled: ready },
  );
  const selectedLine = cart.lines.find((l) => l.key === selected);
  useHotkey(
    (e) => (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey,
    (e) => {
      const idx = cart.lines.findIndex((l) => l.key === selected);
      const next = Math.min(
        cart.lines.length - 1,
        Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)),
      );
      setSelected(cart.lines[next]?.key ?? null);
    },
    { enabled: ready && cart.lines.length > 0 },
  );
  useHotkey(
    (e) => e.key === '+' || e.key === '-',
    (e) => {
      if (!selectedLine) return;
      void mutate((c) =>
        updateLine(c, selectedLine.key, {
          qty_milli: Math.max(
            0,
            selectedLine.qty_milli + (e.key === '+' ? 1000 : -1000),
          ),
        }),
      );
    },
    { enabled: ready && selectedLine !== undefined },
  );
  useHotkey(
    (e) => e.key === 'Delete',
    () => {
      if (selectedLine) void mutate((c) => removeLine(c, selectedLine.key));
      setSelected(null);
    },
    { enabled: ready && selectedLine !== undefined },
  );

  if (device && !device.branch_id) {
    return <p className="p-6 text-center">{t('sell.no_branch')}</p>;
  }

  const emptyTabs = CART_IDS.filter(
    (id) => id !== active && carts && isEmptyCart(carts[id]),
  );
  const noProducts = rows !== undefined && rows.length === 0;

  return (
    <div
      className={`fixed inset-x-0 top-topbar bottom-tabbar flex lg:start-rail lg:bottom-0 ${sheet ? 'z-40' : ''}`}
    >
      <section
        aria-label={t('sell.find_products')}
        className="flex min-w-0 flex-1 flex-col gap-2 p-3 lg:basis-3/5"
      >
        <h1 className="sr-only">{t('nav.sell')}</h1>
        <search>
          <label htmlFor="sell-search" className="sr-only">
            {t('sell.search_label')}
          </label>
          <div className="flex h-14 items-center gap-2 rounded-control border border-border bg-surface px-4 shadow-card focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
            <SearchIcon />
            <input
              id="sell-search"
              ref={searchRef}
              type="search"
              role="combobox"
              aria-expanded={searching}
              aria-controls="sell-results"
              aria-activedescendant={
                highlight >= 0 ? `sell-result-${highlight}` : undefined
              }
              autoComplete="off"
              placeholder={t('sell.search_placeholder')}
              className="min-w-0 flex-1 bg-transparent text-body outline-none"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const now = performance.now();
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const rapid = isRapidBarcode(
                    stamps.current,
                    now,
                    e.currentTarget.value,
                  );
                  stamps.current = [];
                  const value = e.currentTarget.value;
                  // A scanner types the next code straight away: empty the box now.
                  if (rapid) setQuery('');
                  void onEnter(value, rapid);
                  return;
                }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  if (!searching) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setHighlight((h) =>
                    Math.min(
                      results.length - 1,
                      Math.max(0, h + (e.key === 'ArrowDown' ? 1 : -1)),
                    ),
                  );
                  return;
                }
                if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery('');
                  return;
                }
                if (e.key.length === 1)
                  stamps.current = [...stamps.current, now].slice(-64);
              }}
            />
            {nextQty ? (
              <span
                className="rounded-full bg-primary-subtle px-2 text-small text-primary-subtle-ink"
                data-testid="next-qty"
              >
                ×{nextQty / 1000}
              </span>
            ) : null}
          </div>
        </search>
        {!searching ? (
          <CategoryChips selected={categoryId} onPick={setCategoryId} />
        ) : null}
        <div
          ref={scrollRef}
          id="sell-results"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {noProducts ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-text-muted">
                <ProductsIcon />
              </span>
              <p className="text-title">{t('sell.no_products')}</p>
              <div className="flex gap-2">
                {can('catalog.edit') ? (
                  <button
                    type="button"
                    className={buttonPrimary}
                    onClick={() => void navigate({ to: '/products/new' })}
                  >
                    {t('sell.add_product')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={buttonQuiet}
                  onClick={() => setDialog('quick')}
                >
                  {t('sell.quick_sale')}
                </button>
              </div>
            </div>
          ) : searching && results.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <p>{t('sell.no_match', { query: term.trim() })}</p>
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => {
                  setQuickName(term.trim());
                  setDialog('quick');
                }}
              >
                {t('sell.quick_sale_named', { name: term.trim() })}
              </button>
            </div>
          ) : (
            <ProductGrid
              rows={results}
              highlighted={highlight}
              onAdd={addRow}
              scrollRef={scrollRef}
              cartQty={cartQty}
            />
          )}
        </div>
        <div className="flex gap-2 max-lg:hidden">
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => {
              setQuickName('');
              setDialog('quick');
            }}
          >
            {t('sell.quick_sale')}
          </button>
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => setDialog('held')}
          >
            {t('sell.held_bills', { count: heldCount })}
          </button>
        </div>
        <button
          type="button"
          className={`${buttonPrimary} min-h-14 justify-between gap-2 lg:hidden`}
          data-testid="cart-bar"
          aria-expanded={sheet}
          onClick={() => setSheet(true)}
        >
          <span className="min-w-0 truncate">
            {t('sell.view_cart', { count: cart.lines.length })}
          </span>
          <span className="shrink-0">
            <MoneyText paisa={totals.total} />
          </span>
        </button>
      </section>
      <aside
        aria-label={t('sell.cart')}
        className={`flex-col border-border bg-surface p-3 lg:flex lg:basis-2/5 lg:border-s ${sheet ? 'fixed inset-0 z-40 flex' : 'hidden'}`}
      >
        {sheet ? (
          <button
            type="button"
            className={`${buttonQuiet} mb-2 lg:hidden`}
            onClick={() => setSheet(false)}
          >
            {t('sell.back_to_products')}
          </button>
        ) : null}
        {cart.reissue ? (
          <div
            data-testid="reissue-banner"
            className="mb-2 rounded-control border border-warning bg-warning-subtle p-2 text-small text-warning-subtle-ink"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {t('sell.reissue_of', { invoice: reissueInvoice ?? '' })}
              </span>
              <button
                type="button"
                className="underline"
                onClick={() => {
                  const saleId = cart.reissue?.sale_id;
                  void mutate((c) => emptyCart(c.id as CartId)).then(() => {
                    if (saleId)
                      void navigate({
                        to: '/sales/$id',
                        params: { id: saleId },
                      });
                  });
                }}
              >
                {t('sell.reissue_cancel')}
              </button>
            </div>
            <p>{t('sell.reissue_hint')}</p>
          </div>
        ) : null}
        {carts ? (
          <CartPanel
            carts={carts}
            active={active}
            onTab={tab}
            cart={cart}
            totals={totals}
            money={money}
            stock={stock}
            selected={selected}
            onSelect={setSelected}
            expanded={expanded}
            onExpand={setExpanded}
            onChangeLine={(key, patch) =>
              void mutate((c) => updateLine(c, key, patch))
            }
            onRemoveLine={(key) => void mutate((c) => removeLine(c, key))}
            onPriceChange={onPriceChange}
            showCost={money.show_cost_on_till && can('cost.view')}
            onCustomer={() => setDialog('customer')}
            onBillDiscount={() => setDialog('discount')}
            onHold={() => setDialog('hold')}
            onClear={askClear}
            onPay={() => void takePayment()}
            onHeld={() => setDialog('held')}
            heldCount={heldCount}
          />
        ) : null}
      </aside>

      <QuickSaleDialog
        open={dialog === 'quick'}
        onOpenChange={(o) => setDialog(o ? 'quick' : null)}
        initialName={quickName}
        onAdd={(input) => {
          void mutate((c) => addQuickSale(c, input));
          setQuery('');
          setTimeout(focusSearch, 0);
        }}
      />
      <BillDiscountDialog
        open={dialog === 'discount'}
        onOpenChange={(o) => setDialog(o ? 'discount' : null)}
        current={cart.bill_discount}
        onSave={(d) => void mutate((c) => ({ ...c, bill_discount: d }))}
      />
      <HoldDialog
        open={dialog === 'hold'}
        onOpenChange={(o) => setDialog(o ? 'hold' : null)}
        defaultLabel={holdLabel}
        onHold={(l) => void onHold(l)}
      />
      <HeldBillsDialog
        open={dialog === 'held'}
        onOpenChange={(o) => setDialog(o ? 'held' : null)}
        money={money}
        activeEmpty={isEmptyCart(cart)}
        emptyTabs={emptyTabs}
        onResume={(h, into) => void onResume(h, into)}
        onDelete={(h) => void deleteHeld(getDb(), h.id)}
      />
      <CustomerDialog
        open={dialog === 'customer'}
        onOpenChange={(o) => setDialog(o ? 'customer' : null)}
        onPick={(id) => void mutate((c) => ({ ...c, customer_id: id }))}
        actor={staff?.id ?? null}
        canCreate={can('party.edit')}
      />
      <ConfirmDialog
        open={dialog === 'clear'}
        onOpenChange={(o) => setDialog(o ? 'clear' : null)}
        title={t('sell.clear_title')}
        body={t('sell.clear_body', { count: cart.lines.length })}
        confirmLabel={t('sell.clear')}
        onConfirm={() => {
          setDialog(null);
          clearCart();
        }}
      />
      <PayDialog
        open={dialog === 'pay'}
        onOpenChange={(o) => {
          setDialog(o ? 'pay' : null);
          if (!o) setTimeout(focusSearch, 0);
        }}
        cartId={active}
        cart={cart}
        totals={totals}
        money={money}
        requestOverride={(permission, onApproved) =>
          setOverride({ permission, onApproved })
        }
        onScan={(code) => {
          setDialog(null);
          setTimeout(() => {
            focusSearch();
            void onEnter(code, true);
          }, 0);
        }}
        onOpenBill={(bill) => {
          setDialog(null);
          void navigate({ to: '/sales/$id', params: { id: bill } });
        }}
      />
      <OverrideDialog
        open={override !== null}
        onOpenChange={(o) => {
          if (!o) setOverride(null);
        }}
        body={
          override
            ? t(`sell.override_${override.permission.replace('.', '_')}`)
            : undefined
        }
        profiles={
          override
            ? approvers(override.permission).map((s) => ({
                id: s.id,
                label: String(s.name),
              }))
            : []
        }
        verify={verify}
      />
    </div>
  );
}

function CategoryChips({
  selected,
  onPick,
}: {
  selected: string | null;
  onPick: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const cats =
    useLiveQuery(
      async () =>
        (await getDb().categories.orderBy('sort_order').toArray()).filter(
          (c) => !c.deleted_at,
        ),
      [],
    ) ?? [];
  if (cats.length === 0) return null;
  const chip = (on: boolean) =>
    `min-h-11 shrink-0 rounded-full border px-3 text-small ${on ? 'border-primary bg-primary text-primary-ink' : 'border-border bg-surface'}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of filter chips
    <div
      className="flex gap-2 overflow-x-auto"
      aria-label={t('sell.categories')}
      role="group"
    >
      <button
        type="button"
        aria-pressed={selected === null}
        className={chip(selected === null)}
        onClick={() => onPick(null)}
      >
        {t('sell.all')}
      </button>
      {cats.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={selected === c.id}
          className={chip(selected === c.id)}
          onClick={() => onPick(c.id)}
        >
          {String(c.name_en)}
        </button>
      ))}
    </div>
  );
}
