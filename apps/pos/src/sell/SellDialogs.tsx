import { parsePkPhone } from '@bikri/core';
import type { HeldBill } from '@bikri/db';
import {
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

function Actions({
  submit,
  disabled,
  onCancel,
}: {
  submit: string;
  disabled?: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Group justify="flex-end" gap="sm">
      <Button type="button" variant="default" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button type="submit" disabled={disabled}>
        {submit}
      </Button>
    </Group>
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
      <Box component="form" onSubmit={submit}>
        <Stack gap="sm">
          <TextInput
            id={nameId}
            label={t('sell.quick_description')}
            maxLength={60}
            placeholder={t('sell.quick_default')}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <MoneyInput
            label={t('sell.quick_price')}
            value={price}
            onChange={setPrice}
          />
          {error ? (
            <Text size="sm" c="danger">
              {t('sell.quick_price_required')}
            </Text>
          ) : null}
          <QtyInput
            label={t('ui.qty_label')}
            unit="pc"
            value={qty}
            onChange={setQty}
          />
          <Actions
            submit={t('sell.add_to_cart')}
            onCancel={() => onOpenChange(false)}
          />
        </Stack>
      </Box>
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
      <Box component="form" onSubmit={submit}>
        <Stack gap="sm">
          <DiscountToggle type={type} onType={setType} />
          {type === 'amount' ? (
            <MoneyInput
              label={t('sell.discount')}
              value={amount}
              onChange={setAmount}
            />
          ) : (
            <TextInput
              id={pctId}
              label={t('sell.discount_pct')}
              dir="ltr"
              inputMode="decimal"
              value={pct}
              onChange={(event) => setPct(event.currentTarget.value)}
            />
          )}
          <Actions
            submit={t('sell.apply')}
            onCancel={() => onOpenChange(false)}
          />
        </Stack>
      </Box>
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
      <Box
        component="form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onHold(label.trim() || defaultLabel);
          onOpenChange(false);
        }}
      >
        <Stack gap="sm">
          <TextInput
            id={id}
            label={t('sell.hold_label')}
            maxLength={40}
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
          <Actions
            submit={t('sell.hold')}
            onCancel={() => onOpenChange(false)}
          />
        </Stack>
      </Box>
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
        <Text c="dimmed">{t('sell.held_empty')}</Text>
      ) : null}
      <Stack
        gap="sm"
        component="ul"
        aria-label={t('sell.held_title')}
        style={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {held.map((h) => (
          <Paper
            key={h.id}
            component="li"
            withBorder
            p="sm"
            data-testid="held-bill"
          >
            <Stack gap="xs">
              <Group justify="space-between" align="baseline" gap="sm">
                <Text fw={500}>{h.label}</Text>
                <MoneyText
                  paisa={cartTotals({ ...h, id: 'c1' }, money).total}
                />
              </Group>
              <Text size="sm" c="dimmed">
                <Text component="bdi" dir="ltr" inherit>
                  {timeOf(h.held_at, i18n.language)}
                </Text>{' '}
                · {t('sell.items', { count: h.lines.length })} ·{' '}
                {staff?.get(h.held_by) ?? ''}
              </Text>
              <Group gap="xs">
                {activeEmpty ? (
                  <Button type="button" onClick={() => onResume(h, null)}>
                    {t('sell.resume')}
                  </Button>
                ) : (
                  emptyTabs.map((tab) => (
                    <Button
                      key={tab}
                      type="button"
                      variant="default"
                      onClick={() => onResume(h, tab)}
                    >
                      {t('sell.resume_into', { n: CART_IDS.indexOf(tab) + 1 })}
                    </Button>
                  ))
                )}
                {!activeEmpty && emptyTabs.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('sell.no_free_cart')}
                  </Text>
                ) : null}
                {confirm === h.id ? (
                  <Button
                    type="button"
                    color="danger"
                    onClick={() => {
                      setConfirm(null);
                      onDelete(h);
                    }}
                  >
                    {t('sell.delete_confirm')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => setConfirm(h.id)}
                  >
                    {t('sell.delete_held')}
                  </Button>
                )}
              </Group>
            </Stack>
          </Paper>
        ))}
      </Stack>
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
        <Box component="form" onSubmit={(e: FormEvent) => void create(e)}>
          <Stack gap="sm">
            <TextInput
              id={nameId}
              label={t('sell.customer_name')}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <PhoneInput
              label={t('ui.phone_label')}
              value={phone ?? ''}
              onChange={setPhone}
            />
            {error ? (
              <Text size="sm" c="danger">
                {error}
              </Text>
            ) : null}
            <Actions
              submit={t('sell.customer_save')}
              onCancel={() => onOpenChange(false)}
            />
          </Stack>
        </Box>
      ) : (
        <Stack gap="sm">
          <TextInput
            id={searchId}
            type="search"
            label={t('sell.customer_search')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Box
            component="ul"
            aria-label={t('sell.customer_title')}
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              maxHeight: 288,
              overflowY: 'auto',
            }}
          >
            <Box component="li">
              <Button
                type="button"
                variant="transparent"
                fullWidth
                justify="flex-start"
                onClick={() => pick(null)}
              >
                {t('sell.walk_in')}
              </Button>
            </Box>
            {hits.map((h) => (
              <Box component="li" key={h.customer.id}>
                <Button
                  type="button"
                  variant="transparent"
                  fullWidth
                  justify="space-between"
                  onClick={() => pick(h.customer.id)}
                >
                  <Text component="span" size="sm">
                    {String(h.customer.name)}
                    {h.customer.phone ? (
                      <Text
                        component="bdi"
                        dir="ltr"
                        size="sm"
                        c="dimmed"
                        ms={8}
                      >
                        {parsePkPhone(String(h.customer.phone), 'any')
                          ?.display ?? String(h.customer.phone)}
                      </Text>
                    ) : null}
                  </Text>
                  {h.balance > 0 ? (
                    <Text component="span" size="sm" c="var(--color-warning)">
                      {t('sell.owes', {
                        amount: formatShopMoney(h.balance),
                      })}
                    </Text>
                  ) : null}
                </Button>
              </Box>
            ))}
          </Box>
          {canCreate ? (
            <Button
              type="button"
              variant="default"
              onClick={() => {
                setCreating(true);
                setName(/\d/u.test(query) ? '' : query);
              }}
              style={{ alignSelf: 'flex-start' }}
            >
              {t('sell.new_customer')}
            </Button>
          ) : null}
        </Stack>
      )}
    </Modal>
  );
}
