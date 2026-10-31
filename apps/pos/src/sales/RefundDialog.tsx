import { isQtyUnit, newId } from '@bikri/core';
import {
  Box,
  Button,
  Checkbox,
  Group,
  Paper,
  Radio,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyText } from '../components/MoneyText.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { CART_IDS, emptyCart, isEmptyCart, loadCarts } from '../data/cart.ts';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { queueRefundPrint } from '../data/refundReceipt.ts';
import {
  computeRefund,
  RefundNotAllowedError,
  refundSale,
} from '../data/refunds.ts';
import { billDetail } from '../data/salesHistory.ts';
import { formatShopMoney } from '../lib/money';
import { Modal } from '../sell/Modal.tsx';
import { useSellStore } from '../sell/sellStore.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { ApprovalDialog } from './ApprovalDialog.tsx';
import {
  METHOD_KEYS,
  REFUND_REASONS,
  type ReasonKey,
  reasonLabel,
} from './format.ts';

type Choice = { saleLineId: string; qtyMilli: number; restock: boolean };

/** Refund modal (screens/11), route `/sales/:id/refund`. */
export function RefundDialog({
  saleId,
  open,
  onClose,
}: {
  saleId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const [mode, setMode] = useState<'whole' | 'items'>('whole');
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState<'cash' | 'card' | 'bank_wallet'>('cash');
  const [reasonKey, setReasonKey] = useState<ReasonKey | ''>('');
  const [reasonText, setReasonText] = useState('');
  const [refundId, setRefundId] = useState(() => newId());
  const [approving, setApproving] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const detail = useLiveQuery(() => billDetail(getDb(), saleId), [saleId]);
  const printer = useLiveQuery(
    async () =>
      ((await getDb().kv.get('printer'))?.value ?? null) as {
        auto_print?: boolean;
      } | null,
    [],
  );
  const printOn = printer ? printer.auto_print !== false : false;

  useEffect(() => {
    if (!open) return;
    setRefundId(newId());
    setDone(null);
    setReasonKey('');
    setReasonText('');
    setQty({});
    setRestock({});
  }, [open]);

  useEffect(() => {
    if (!detail || done) return;
    const refundable = detail.lines.filter((l) => l.keptMilli > 0).length;
    setMode(refundable > 1 ? 'items' : 'whole');
  }, [detail, done]);

  const chosen: Choice[] = useMemo(() => {
    if (!detail) return [];
    return detail.lines.flatMap(({ line, keptMilli }) => {
      const requested = mode === 'whole' ? keptMilli : (qty[line.id] ?? 0);
      const amount = Math.min(Math.max(0, requested), keptMilli);
      if (amount <= 0) return [];
      return [
        {
          saleLineId: line.id,
          qtyMilli: amount,
          restock: restock[line.id] !== false,
        },
      ];
    });
  }, [detail, mode, qty, restock]);
  const signature = JSON.stringify(chosen);

  const planRow = useLiveQuery(async () => {
    if (!open || !detail || chosen.length === 0) return null;
    try {
      return {
        plan: await computeRefund(getDb(), saleId, chosen, method),
      };
    } catch (err) {
      return {
        error:
          err instanceof RefundNotAllowedError ? err.code : ('error' as const),
      };
    }
  }, [saleId, signature, method, open, detail === undefined]);
  const plan = planRow && 'plan' in planRow ? planRow.plan : null;
  const errorCode = planRow && 'error' in planRow ? planRow.error : null;

  const reason =
    reasonKey === 'other'
      ? reasonText.trim()
      : reasonKey
        ? reasonLabel(t, reasonKey, 'refund')
        : '';
  const canSave =
    plan !== null &&
    reason.length > 0 &&
    reason.length <= 120 &&
    !pending &&
    done === null &&
    !readOnly;

  const methods = useMemo(() => {
    const used = new Set<'cash' | 'card' | 'bank_wallet'>(['cash']);
    for (const p of detail?.payments ?? []) {
      if (p.direction !== 'in' || p.purpose !== 'sale') continue;
      const value = String(p.method);
      if (value === 'cash' || value === 'card' || value === 'bank_wallet')
        used.add(value);
    }
    return [...used];
  }, [detail]);

  const save = async (approvedBy: string | null) => {
    if (!plan || !canSave) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      const result = await refundSale(
        db,
        {
          refundId,
          saleId,
          lines: chosen,
          reason,
          method,
          override: approvedBy ? { approved_by: approvedBy } : null,
          print: printOn,
        },
        ctx,
      );
      setDone(String(result.refund.id));
      toast.push(t('office.refund.done'));
    } catch (err) {
      if (err instanceof RefundNotAllowedError) {
        toast.push(t(`office.refund.error_${err.code}`), 'error');
        return;
      }
      toast.push(t('errors.generic'), 'error');
    } finally {
      setPending(false);
    }
  };

  const startExchange = async () => {
    if (!detail?.customer) {
      void navigate({ to: '/sell' });
      return;
    }
    const db = getDb();
    const carts = await loadCarts(db);
    const target = CART_IDS.find((id) => isEmptyCart(carts[id]));
    if (target) {
      const cart = carts[target] ?? emptyCart(target);
      await db.carts.put({
        ...cart,
        customer_id: String(detail.customer.id),
        updated_at: Date.now(),
      });
      useSellStore.getState().setActive(target);
    }
    void navigate({ to: '/sell' });
  };

  const title = detail
    ? t('office.refund.title', {
        invoice: String(detail.sale.invoice_no),
      })
    : t('office.refund.title_plain');

  if (done) {
    return (
      <Modal open={open} onOpenChange={(o) => !o && onClose()} title={title}>
        <Stack gap="sm">
          <Text fz="lg" fw={600} data-testid="refund-saved">
            {t('office.refund.done')}
          </Text>
          <Group gap="sm">
            <Button
              type="button"
              variant="default"
              onClick={() => {
                void queueRefundPrint(getDb(), done).then(() =>
                  toast.push(t('office.bill.print_queued')),
                );
              }}
            >
              {t('office.bill.print_refund')}
            </Button>
            {reasonKey === 'exchange' ? (
              <Button type="button" onClick={() => void startExchange()}>
                {t('office.refund.start_new_sale')}
              </Button>
            ) : null}
            <Button type="button" onClick={onClose}>
              {t('common.close')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      wide
      description={t('office.refund.hint')}
    >
      <Stack gap="md">
        <Box component="fieldset" style={{ border: 0, margin: 0, padding: 0 }}>
          <Text component="legend" size="sm" mb={4}>
            {t('office.refund.mode')}
          </Text>
          <Group gap="xs">
            <Button
              type="button"
              size="compact-sm"
              variant={mode === 'whole' ? 'light' : 'default'}
              aria-pressed={mode === 'whole'}
              onClick={() => setMode('whole')}
            >
              {t('office.refund.mode_whole')}
            </Button>
            <Button
              type="button"
              size="compact-sm"
              variant={mode === 'items' ? 'light' : 'default'}
              aria-pressed={mode === 'items'}
              onClick={() => setMode('items')}
            >
              {t('office.refund.mode_items')}
            </Button>
          </Group>
        </Box>

        {!detail ? (
          <Text size="sm" c="dimmed">
            {t('common.loading')}
          </Text>
        ) : (
          <Stack gap="sm">
            {detail.lines.map(({ line, refundedMilli, keptMilli, unit }) => {
              const selected = chosen.some((c) => c.saleLineId === line.id);
              const amount =
                plan?.lines.find((l) => l.saleLineId === line.id)?.amount ?? 0;
              const qtyUnit = isQtyUnit(unit) ? unit : 'pc';
              return (
                <Paper key={line.id} withBorder p="sm">
                  <Stack gap="xs">
                    <Group justify="space-between" gap="sm" wrap="wrap">
                      {mode === 'items' ? (
                        <Checkbox
                          label={String(line.name_snapshot)}
                          checked={selected}
                          disabled={keptMilli <= 0}
                          onChange={(event) =>
                            setQty((current) => ({
                              ...current,
                              [line.id]: event.currentTarget.checked
                                ? keptMilli
                                : 0,
                            }))
                          }
                        />
                      ) : (
                        <Text size="sm" fw={500}>
                          • {String(line.name_snapshot)}
                        </Text>
                      )}
                      <Text size="sm" c="dimmed">
                        {t('office.refund.sold', {
                          qty: `${Number(line.qty_milli) / 1000} ${t(`unit.${qtyUnit}`)}`,
                        })}
                        {refundedMilli > 0
                          ? ` · ${t('office.refund.already', {
                              qty: refundedMilli / 1000,
                            })}`
                          : ''}
                      </Text>
                    </Group>
                    {selected ? (
                      <Group align="flex-end" gap="sm" wrap="wrap">
                        {mode === 'items' ? (
                          <Box w={144}>
                            <QtyInput
                              label={t('office.refund.qty')}
                              unit={qtyUnit}
                              value={qty[line.id] ?? 0}
                              onChange={(milli) =>
                                setQty((current) => ({
                                  ...current,
                                  [line.id]: Math.min(
                                    Math.max(0, milli ?? 0),
                                    keptMilli,
                                  ),
                                }))
                              }
                            />
                          </Box>
                        ) : (
                          <Text size="sm" c="dimmed">
                            {t('office.refund.qty')}: {keptMilli / 1000}{' '}
                            {t(`unit.${qtyUnit}`)}
                          </Text>
                        )}
                        <Text size="sm" ms="auto" ta="end">
                          <MoneyText paisa={amount} />
                        </Text>
                        <Checkbox
                          size="sm"
                          label={t('office.refund.restock')}
                          checked={restock[line.id] !== false}
                          onChange={(event) =>
                            setRestock((current) => ({
                              ...current,
                              [line.id]: event.currentTarget.checked,
                            }))
                          }
                        />
                      </Group>
                    ) : null}
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        )}

        <Box component="fieldset" style={{ border: 0, margin: 0, padding: 0 }}>
          <Text component="legend" size="sm" mb={4}>
            {t('office.refund.reason')}
          </Text>
          <Group gap="xs">
            {REFUND_REASONS.map((r) => (
              <Button
                key={r}
                type="button"
                size="compact-sm"
                variant={reasonKey === r ? 'light' : 'default'}
                aria-pressed={reasonKey === r}
                onClick={() => setReasonKey(r)}
              >
                {reasonLabel(t, r, 'refund')}
              </Button>
            ))}
          </Group>
          {reasonKey === 'other' ? (
            <TextInput
              mt="xs"
              maxLength={120}
              placeholder={t('office.refund.reason_other_label')}
              aria-label={t('office.refund.reason_other_label')}
              value={reasonText}
              onChange={(event) => setReasonText(event.currentTarget.value)}
            />
          ) : null}
        </Box>

        {detail && Number(detail.sale.udhaar_amount) > 0 ? (
          <Paper p="sm" bg="var(--mantine-color-default-hover)">
            <Text size="sm" fw={500}>
              {t('office.refund.split_title')}
            </Text>
            <Text size="sm">
              {t('office.refund.split_body', {
                exact: formatShopMoney(plan?.exact ?? 0),
                paid: formatShopMoney(plan?.amount ?? 0),
                udhaar: formatShopMoney(plan?.udhaarPart ?? 0),
                name: detail.customer ? String(detail.customer.name) : '',
              })}
            </Text>
          </Paper>
        ) : null}

        {plan && plan.paidExact > 0 ? (
          <Radio.Group
            label={t('office.refund.method')}
            value={method}
            onChange={(value) =>
              setMethod(value as 'cash' | 'card' | 'bank_wallet')
            }
          >
            <Group gap="sm" mt="xs">
              {methods.map((m) => (
                <Radio key={m} value={m} label={t(METHOD_KEYS[m])} />
              ))}
            </Group>
          </Radio.Group>
        ) : plan && plan.udhaarPart > 0 ? (
          <Paper p="sm" bg="var(--mantine-color-warning-subtle)">
            <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
              {t('office.refund.khata_only', {
                amount: formatShopMoney(plan.udhaarPart),
                name: detail?.customer ? String(detail.customer.name) : '',
              })}
            </Text>
          </Paper>
        ) : null}

        {plan ? (
          <Paper withBorder p="sm">
            <Stack gap={4}>
              <Group justify="space-between" gap="sm">
                <Text size="sm">{t('office.refund.exact')}</Text>
                <Text size="sm">
                  <MoneyText paisa={plan.exact} />
                </Text>
              </Group>
              {plan.method === 'cash' && plan.rounding !== 0 ? (
                <Group justify="space-between" gap="sm">
                  <Text size="sm">{t('office.refund.rounding')}</Text>
                  <Text size="sm">
                    <MoneyText paisa={plan.rounding} />
                  </Text>
                </Group>
              ) : null}
              <Group
                justify="space-between"
                gap="sm"
                pt="xs"
                style={{
                  borderTop: '1px solid var(--mantine-color-default-border)',
                }}
              >
                <Text size="md" fw={600}>
                  {plan.amount > 0
                    ? t('office.refund.refund_amount')
                    : t('office.refund.reduce_khata')}
                </Text>
                <Text size="md" fw={600}>
                  <MoneyText
                    paisa={plan.amount > 0 ? plan.amount : plan.udhaarPart}
                  />
                </Text>
              </Group>
              {plan.udhaarPart > 0 ? (
                <Group justify="space-between" gap="sm">
                  <Text size="sm">
                    {t('office.refund.khata_after', {
                      name: detail?.customer
                        ? String(detail.customer.name)
                        : '',
                    })}
                  </Text>
                  <Text size="sm">
                    <MoneyText paisa={plan.khataAfter} />
                  </Text>
                </Group>
              ) : null}
            </Stack>
          </Paper>
        ) : null}

        {errorCode && errorCode !== 'nothing' ? (
          <Text c="danger" role="alert" size="sm">
            {t(`office.refund.error_${errorCode}`)}
          </Text>
        ) : null}
        {reason.length > 120 ? (
          <Text c="danger" role="alert" size="sm">
            {t('office.refund.error_reason')}
          </Text>
        ) : null}
        {plan && reason.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('office.refund.choose_reason')}
          </Text>
        ) : null}

        <Group justify="flex-end" gap="sm">
          <Button type="button" variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            color="danger"
            disabled={!canSave}
            aria-busy={pending}
            loading={pending}
            onClick={() => {
              if (!can('refund.create')) {
                setApproving(true);
                return;
              }
              void save(null);
            }}
          >
            {plan && plan.amount > 0
              ? t('office.refund.button', {
                  amount: formatShopMoney(plan.amount),
                })
              : plan && plan.udhaarPart > 0
                ? t('office.refund.button_khata', {
                    amount: formatShopMoney(plan.udhaarPart),
                  })
                : t('office.refund.button_empty')}
          </Button>
        </Group>
        {!can('refund.create') ? (
          <Text size="sm" c="dimmed">
            {t('office.refund.override_hint')}
          </Text>
        ) : null}
      </Stack>

      <ApprovalDialog
        open={approving}
        onOpenChange={(o) => {
          if (!o) setApproving(false);
        }}
        permission="refund.create"
        body={t('office.refund.override_body')}
        onApproved={(approvedBy) => {
          setApproving(false);
          void save(approvedBy);
        }}
      />
    </Modal>
  );
}
