import { parsePkPhone } from '@bikri/core';
import type { HeldBill } from '@bikri/db';
import * as Dialog from '@radix-ui/react-dialog';
import { useLiveQuery } from 'dexie-react-hooks';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PhoneInput } from '../components/PhoneInput.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  CART_IDS,
  type CartId,
  cartTotals,
  listHeld,
  type ShopMoney,
} from '../data/cart.ts';
import {
  createCustomer,
  DuplicatePhoneError,
  findCustomers,
} from '../data/customers.ts';
import { getDb } from '../data/db.ts';
import { formatShopMoney } from '../lib/money';
import { DiscountToggle, percentToBp } from './LineEditor.tsx';
import { Modal } from './Modal.tsx';

function Actions({ submit, disabled }: { submit: string; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Dialog.Close asChild>
        <button type="button" className={buttonQuiet}>
          {t('common.cancel')}
        </button>
      </Dialog.Close>
      <button type="submit" className={buttonPrimary} disabled={disabled}>
        {submit}
      </button>
    </div>
  );
}

/** F7: description, price (> 0) and qty; no product, no stock movement (screens/05). */
export function QuickSaleDialog({
  open,
  onOpenChange,
  initialName,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName: string;
  onAdd: (input: { name: string; price: number; qtyMilli: number }) => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const [name, setName] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  const [qty, setQty] = useState<number | null>(1000);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setPrice(null);
    setQty(1000);
    setError(false);
  }, [open, initialName]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (price === null || price <= 0 || !qty) {
      setError(true);
      return;
    }
    onAdd({
      name: name.trim() || t('sell.quick_default'),
      price,
      qtyMilli: qty,
    });
    onOpenChange(false);
  };
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('sell.quick_sale')}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div>
          <label htmlFor={nameId} className="mb-1 block text-small">
            {t('sell.quick_description')}
          </label>
          <input
            id={nameId}
            className={fieldClass}
            maxLength={60}
            placeholder={t('sell.quick_default')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <MoneyInput
          label={t('sell.quick_price')}
          value={price}
          onChange={setPrice}
        />
        {error ? (
          <p className="text-small text-danger">
            {t('sell.quick_price_required')}
          </p>
        ) : null}
        <QtyInput
          label={t('ui.qty_label')}
          unit="pc"
          value={qty}
          onChange={setQty}
        />
        <Actions submit={t('sell.add_to_cart')} />
      </form>
    </Modal>
  );
}

/** F3: bill discount in Rs or %. */
export function BillDiscountDialog({
  open,
  onOpenChange,
  current,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: { type: 'amount' | 'percent'; value: number } | null | undefined;
  onSave: (d: { type: 'amount' | 'percent'; value: number } | null) => void;
}) {
  const { t } = useTranslation();
  const pctId = useId();
  const [type, setType] = useState<'amount' | 'percent'>('amount');
  const [amount, setAmount] = useState<number | null>(null);
  const [pct, setPct] = useState('');
  useEffect(() => {
    if (!open) return;
    setType(current?.type ?? 'amount');
    setAmount(current?.type === 'amount' ? current.value : null);
    setPct(current?.type === 'percent' ? String(current.value / 100) : '');
  }, [open, current]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = type === 'amount' ? (amount ?? 0) : (percentToBp(pct) ?? 0);
    onSave(value > 0 ? { type, value } : null);
    onOpenChange(false);
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('sell.bill_discount')}
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <DiscountToggle type={type} onType={setType} />
        {type === 'amount' ? (
          <MoneyInput
            label={t('sell.discount')}
            value={amount}
            onChange={setAmount}
          />
        ) : (
          <div>
            <label htmlFor={pctId} className="mb-1 block text-small">
              {t('sell.discount_pct')}
            </label>
            <input
              id={pctId}
              dir="ltr"
              inputMode="decimal"
              className={fieldClass}
              value={pct}
              onChange={(e) => setPct(e.target.value)}
            />
          </div>
        )}
        <Actions submit={t('sell.apply')} />
      </form>
    </Modal>
  );
}

/** Ctrl+H / F4: label (default customer name or "Held 10:42"). */
export function HoldDialog({
  open,
  onOpenChange,
  defaultLabel,
  onHold,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultLabel: string;
  onHold: (label: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (open) setLabel(defaultLabel);
  }, [open, defaultLabel]);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('sell.hold_title')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onHold(label.trim() || defaultLabel);
          onOpenChange(false);
        }}
      >
        <div>
          <label htmlFor={id} className="mb-1 block text-small">
            {t('sell.hold_label')}
          </label>
          <input
            id={id}
            className={fieldClass}
            maxLength={40}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <Actions submit={t('sell.hold')} />
      </form>
    </Modal>
  );
}

export function timeOf(at: number, lang: string): string {
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-PK', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Karachi',
  }).format(at);
}

/** F6: held bills on this device; resume into the active tab or an empty one. */
export function HeldBillsDialog({
  open,
  onOpenChange,
  money,
  activeEmpty,
  emptyTabs,
  onResume,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  money: ShopMoney;
  activeEmpty: boolean;
  emptyTabs: CartId[];
  onResume: (held: HeldBill, into: CartId | null) => void;
  onDelete: (held: HeldBill) => void;
}) {
  const { t, i18n } = useTranslation();
  const held = useLiveQuery(() => listHeld(getDb()), [open]) ?? [];
  const staff = useLiveQuery(
    async () =>
      new Map(
        (await getDb().staff.toArray()).map((s) => [s.id, String(s.name)]),
      ),
    [],
  );
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('sell.held_title')}
      wide
    >
      {held.length === 0 ? (
        <p className="text-text-muted">{t('sell.held_empty')}</p>
      ) : null}
      <ul className="flex flex-col gap-2" aria-label={t('sell.held_title')}>
        {held.map((h) => (
          <li
            key={h.id}
            className="flex flex-col gap-2 rounded-card border border-border p-2"
            data-testid="held-bill"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{h.label}</span>
              <MoneyText paisa={cartTotals({ ...h, id: 'c1' }, money).total} />
            </div>
            <p className="text-small text-text-muted">
              <bdi dir="ltr">{timeOf(h.held_at, i18n.language)}</bdi> ·{' '}
              {t('sell.items', { count: h.lines.length })} ·{' '}
              {staff?.get(h.held_by) ?? ''}
            </p>
            <div className="flex flex-wrap gap-2">
              {activeEmpty ? (
                <button
                  type="button"
                  className={buttonPrimary}
                  onClick={() => onResume(h, null)}
                >
                  {t('sell.resume')}
                </button>
              ) : (
                emptyTabs.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={buttonQuiet}
                    onClick={() => onResume(h, tab)}
                  >
                    {t('sell.resume_into', { n: CART_IDS.indexOf(tab) + 1 })}
                  </button>
                ))
              )}
              {!activeEmpty && emptyTabs.length === 0 ? (
                <span className="text-small text-text-muted">
                  {t('sell.no_free_cart')}
                </span>
              ) : null}
              {confirm === h.id ? (
                <button
                  type="button"
                  className={`${buttonQuiet} text-danger`}
                  onClick={() => {
                    setConfirm(null);
                    onDelete(h);
                  }}
                >
                  {t('sell.delete_confirm')}
                </button>
              ) : (
                <button
                  type="button"
                  className={buttonQuiet}
                  onClick={() => setConfirm(h.id)}
                >
                  {t('sell.delete_held')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Change customer: search by name/phone, walk-in, or + New customer. */
export function CustomerDialog({
  open,
  onOpenChange,
  onPick,
  actor,
  canCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (id: string | null) => void;
  actor: string | null;
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const searchId = useId();
  const nameId = useId();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCreating(false);
    setName('');
    setPhone(null);
    setError(null);
  }, [open]);
  const hits = useLiveQuery(() => findCustomers(getDb(), query), [query]) ?? [];
  const pick = (id: string | null) => {
    onPick(id);
    onOpenChange(false);
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t('sell.customer_name_required'));
      return;
    }
    try {
      const c = await createCustomer(getDb(), { name, phone }, actor);
      toast.push(t('sell.customer_added', { name: String(c.name) }));
      pick(c.id);
    } catch (err) {
      setError(
        err instanceof DuplicatePhoneError
          ? t('sell.phone_taken', { name: err.ownerName })
          : t('errors.generic'),
      );
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('sell.customer_title')}
    >
      {creating ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => void create(e)}>
          <div>
            <label htmlFor={nameId} className="mb-1 block text-small">
              {t('sell.customer_name')}
            </label>
            <input
              id={nameId}
              className={fieldClass}
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <PhoneInput
            label={t('ui.phone_label')}
            value={phone ?? ''}
            onChange={setPhone}
          />
          {error ? <p className="text-small text-danger">{error}</p> : null}
          <Actions submit={t('sell.customer_save')} />
        </form>
      ) : (
        <>
          <div>
            <label htmlFor={searchId} className="mb-1 block text-small">
              {t('sell.customer_search')}
            </label>
            <input
              id={searchId}
              type="search"
              className={fieldClass}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <ul
            className="flex max-h-72 flex-col gap-1 overflow-y-auto"
            aria-label={t('sell.customer_title')}
          >
            <li>
              <button
                type="button"
                className="min-h-11 w-full rounded-control px-2 text-start hover:bg-surface-2"
                onClick={() => pick(null)}
              >
                {t('sell.walk_in')}
              </button>
            </li>
            {hits.map((h) => (
              <li key={h.customer.id}>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-control px-2 text-start hover:bg-surface-2"
                  onClick={() => pick(h.customer.id)}
                >
                  <span>
                    {String(h.customer.name)}
                    {h.customer.phone ? (
                      <bdi
                        dir="ltr"
                        className="ms-2 text-small text-text-muted"
                      >
                        {parsePkPhone(String(h.customer.phone), 'any')
                          ?.display ?? String(h.customer.phone)}
                      </bdi>
                    ) : null}
                  </span>
                  {h.balance > 0 ? (
                    <span className="text-small text-warning">
                      {t('sell.owes', { amount: formatShopMoney(h.balance) })}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          {canCreate ? (
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => {
                setCreating(true);
                setName(/\d/u.test(query) ? '' : query);
              }}
            >
              {t('sell.new_customer')}
            </button>
          ) : null}
        </>
      )}
    </Modal>
  );
}
