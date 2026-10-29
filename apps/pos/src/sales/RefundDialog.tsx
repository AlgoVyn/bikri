import { formatMoney, isQtyUnit, newId } from '@bikri/core';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
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
        <p className="text-title font-semibold" data-testid="refund-saved">
          {t('office.refund.done')}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => {
              void queueRefundPrint(getDb(), done).then(() =>
                toast.push(t('office.bill.print_queued')),
              );
            }}
          >
            {t('office.bill.print_refund')}
          </button>
          {reasonKey === 'exchange' ? (
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => void startExchange()}
            >
              {t('office.refund.start_new_sale')}
            </button>
          ) : null}
          <button type="button" className={buttonPrimary} onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
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
      <fieldset>
        <legend className="mb-1 text-small">{t('office.refund.mode')}</legend>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={mode === 'whole'}
            className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
            onClick={() => setMode('whole')}
          >
            {t('office.refund.mode_whole')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'items'}
            className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
            onClick={() => setMode('items')}
          >
            {t('office.refund.mode_items')}
          </button>
        </div>
      </fieldset>

      {!detail ? (
        <p className="sr-only">{t('common.loading')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {detail.lines.map(({ line, refundedMilli, keptMilli, unit }) => {
            const selected = chosen.some((c) => c.saleLineId === line.id);
            const amount =
              plan?.lines.find((l) => l.saleLineId === line.id)?.amount ?? 0;
            const qtyUnit = isQtyUnit(unit) ? unit : 'pc';
            return (
              <li
                key={line.id}
                className="flex flex-col gap-1 rounded-control border border-border p-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  {mode === 'items' ? (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={keptMilli <= 0}
                        onChange={(e) =>
                          setQty((current) => ({
                            ...current,
                            [line.id]: e.target.checked ? keptMilli : 0,
                          }))
                        }
                      />
                      <span className="font-medium">
                        {String(line.name_snapshot)}
                      </span>
                    </label>
                  ) : (
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true">•</span>
                      <span className="font-medium">
                        {String(line.name_snapshot)}
                      </span>
                    </span>
                  )}
                  <span className="text-small text-text-muted">
                    {t('office.refund.sold', {
                      qty: `${Number(line.qty_milli) / 1000} ${t(`unit.${qtyUnit}`)}`,
                    })}
                    {refundedMilli > 0
                      ? ` · ${t('office.refund.already', {
                          qty: refundedMilli / 1000,
                        })}`
                      : ''}
                  </span>
                </div>
                {selected ? (
                  <div className="flex flex-wrap items-end gap-2">
                    {mode === 'items' ? (
                      <div className="w-36">
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
                      </div>
                    ) : (
                      <p className="text-small text-text-muted">
                        {t('office.refund.qty')}: {keptMilli / 1000}{' '}
                        {t(`unit.${qtyUnit}`)}
                      </p>
                    )}
                    <p className="ms-auto text-end">
                      <MoneyText paisa={amount} />
                    </p>
                    <label className="flex items-center gap-1 text-small">
                      <input
                        type="checkbox"
                        checked={restock[line.id] !== false}
                        onChange={(e) =>
                          setRestock((current) => ({
                            ...current,
                            [line.id]: e.target.checked,
                          }))
                        }
                      />
                      {t('office.refund.restock')}
                    </label>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <fieldset>
        <legend className="mb-1 text-small">{t('office.refund.reason')}</legend>
        <div className="flex flex-wrap gap-2">
          {REFUND_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={reasonKey === r}
              className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
              onClick={() => setReasonKey(r)}
            >
              {reasonLabel(t, r, 'refund')}
            </button>
          ))}
        </div>
        {reasonKey === 'other' ? (
          <input
            className={`${fieldClass} mt-2`}
            maxLength={120}
            placeholder={t('office.refund.reason_other_label')}
            value={reasonText}
            onChange={(e) => setReasonText(e.target.value)}
          />
        ) : null}
      </fieldset>

      {detail && Number(detail.sale.udhaar_amount) > 0 ? (
        <div className="rounded-control bg-surface-2 p-2 text-small">
          <p className="font-medium">{t('office.refund.split_title')}</p>
          <p>
            {t('office.refund.split_body', {
              exact: formatMoney(plan?.exact ?? 0),
              paid: formatMoney(plan?.amount ?? 0),
              udhaar: formatMoney(plan?.udhaarPart ?? 0),
              name: detail.customer ? String(detail.customer.name) : '',
            })}
          </p>
        </div>
      ) : null}

      {plan && plan.paidExact > 0 ? (
        <fieldset>
          <legend className="mb-1 text-small">
            {t('office.refund.method')}
          </legend>
          <div className="flex flex-wrap gap-3">
            {methods.map((m) => (
              <label key={m} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="refund-method"
                  checked={method === m}
                  onChange={() => setMethod(m)}
                />
                {t(METHOD_KEYS[m])}
              </label>
            ))}
          </div>
        </fieldset>
      ) : plan && plan.udhaarPart > 0 ? (
        <p className="rounded-control bg-warning-subtle p-2 text-warning-subtle-ink">
          {t('office.refund.khata_only', {
            amount: formatMoney(plan.udhaarPart),
            name: detail?.customer ? String(detail.customer.name) : '',
          })}
        </p>
      ) : null}

      {plan ? (
        <dl className="rounded-control border border-border p-2 text-small">
          <div className="flex justify-between gap-2">
            <dt>{t('office.refund.exact')}</dt>
            <dd>
              <MoneyText paisa={plan.exact} />
            </dd>
          </div>
          {plan.method === 'cash' && plan.rounding !== 0 ? (
            <div className="flex justify-between gap-2">
              <dt>{t('office.refund.rounding')}</dt>
              <dd>
                <MoneyText paisa={plan.rounding} />
              </dd>
            </div>
          ) : null}
          <div className="mt-1 flex justify-between gap-2 border-t border-border pt-1 text-total font-semibold">
            <dt>
              {plan.amount > 0
                ? t('office.refund.refund_amount')
                : t('office.refund.reduce_khata')}
            </dt>
            <dd>
              <MoneyText
                paisa={plan.amount > 0 ? plan.amount : plan.udhaarPart}
              />
            </dd>
          </div>
          {plan.udhaarPart > 0 ? (
            <div className="mt-1 flex justify-between gap-2">
              <dt>
                {t('office.refund.khata_after', {
                  name: detail?.customer ? String(detail.customer.name) : '',
                })}
              </dt>
              <dd>
                <MoneyText paisa={plan.khataAfter} />
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {errorCode && errorCode !== 'nothing' ? (
        <p className="text-danger" role="alert">
          {t(`office.refund.error_${errorCode}`)}
        </p>
      ) : null}
      {reason.length > 120 ? (
        <p className="text-danger" role="alert">
          {t('office.refund.error_reason')}
        </p>
      ) : null}

      {plan && reason.length === 0 ? (
        <p className="text-small text-text-muted">
          {t('office.refund.choose_reason')}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonQuiet} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={buttonDanger}
          disabled={!canSave}
          aria-busy={pending}
          onClick={() => {
            if (!can('refund.create')) {
              setApproving(true);
              return;
            }
            void save(null);
          }}
        >
          {plan && plan.amount > 0
            ? t('office.refund.button', { amount: formatMoney(plan.amount) })
            : plan && plan.udhaarPart > 0
              ? t('office.refund.button_khata', {
                  amount: formatMoney(plan.udhaarPart),
                })
              : t('office.refund.button_empty')}
        </button>
      </div>
      {!can('refund.create') ? (
        <p className="text-small text-text-muted">
          {t('office.refund.override_hint')}
        </p>
      ) : null}

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
