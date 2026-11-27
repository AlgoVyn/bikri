import {
  businessDate,
  formatQtyFromMilli,
  isQtyUnit,
  newId,
} from '@bikri/core';
import type { SyncedRow } from '@bikri/db';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
import { DialogFooter } from '../components/DialogFooter.tsx';
import { Modal } from '../components/Modal.tsx';
import { MoneyText, useDisplayMoney } from '../components/MoneyText.tsx';
import { PageLoading } from '../components/PageLoading';
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
import { shopTimeZone } from '../data/shopTimeZone.ts';
import {
  METHOD_KEYS,
  REFUND_REASONS,
  type ReasonKey,
  reasonLabel,
} from '../lib/salesFormat.ts';
import { kickDrawerForCash } from '../print/drawer.ts';
import { useSellStore } from '../sell/sellStore.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { billVisible } from '../state/reportScope.ts';
import { ApprovalDialog } from './ApprovalDialog.tsx';

type Choice = { saleLineId: string; qtyMilli: number; restock: boolean };

type SelectableLine = { line: SyncedRow; keptMilli: number };

/**
 * The stock-handling choice is a separate document-level decision, not a third column
 * beside quantity and amount. Keep it full width and visually distinct from the numeric
 * controls so it reads as a choice, not a value.
 */
function RestockOption({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      className="mt-1 flex min-h-11 cursor-pointer items-center gap-2 rounded-control bg-surface-2/60 px-2.5 text-small transition-colors hover:bg-surface-2"
      title={hint}
    >
      <input
        type="checkbox"
        className="size-4 shrink-0"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0 truncate">{label}</span>
    </label>
  );
}

/**
 * The refund lines a set of checked rows and draft quantities describes (UI-H3).
 * Checked state is separate from the draft: clearing or backspacing a `QtyInput`
 * empties that row's draft (`null`) without unchecking it or unmounting the input.
 */
export function pickRefundChoices(
  lines: readonly SelectableLine[],
  mode: 'whole' | 'items',
  checked: Readonly<Record<string, boolean>>,
  drafts: Readonly<Record<string, number | null>>,
  restock: Readonly<Record<string, boolean>>,
): Choice[] {
  const out: Choice[] = [];
  const seenGroups = new Set<string>();
  for (const { line, keptMilli } of lines) {
    const group = line.bundle_group ? String(line.bundle_group) : null;
    if (group !== null) {
      if (seenGroups.has(group)) continue;
      seenGroups.add(group);
      const groupLines = lines.filter(
        (row) => String(row.line.bundle_group ?? '') === group,
      );
      const remaining = Math.min(
        ...groupLines.map(({ line: row, keptMilli: kept }) => {
          const perBundle = Number(row.bundle_component_qty_milli ?? 0);
          return perBundle > 0 ? Math.floor(kept / perBundle) : 0;
        }),
      );
      if (mode === 'items' && checked[group] !== true) continue;
      const k =
        mode === 'whole'
          ? remaining
          : Math.min(
              Math.max(0, Math.floor((drafts[group] ?? 0) / 1000)),
              remaining,
            );
      if (k <= 0) continue;
      for (const { line: row } of groupLines) {
        const perBundle = Number(row.bundle_component_qty_milli ?? 0);
        if (perBundle <= 0) continue;
        out.push({
          saleLineId: String(row.id),
          qtyMilli: perBundle * k,
          restock: restock[group] !== false,
        });
      }
      continue;
    }
    const requested =
      mode === 'whole'
        ? keptMilli
        : checked[line.id] === true
          ? (drafts[line.id] ?? 0)
          : 0;
    const amount = Math.min(Math.max(0, requested), keptMilli);
    if (amount > 0)
      out.push({
        saleLineId: String(line.id),
        qtyMilli: amount,
        restock: restock[line.id] !== false,
      });
  }
  return out;
}

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
  const money = useDisplayMoney();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff, can, role, support, branchId } = useCurrentStaff();
  const readOnly = useReadOnly();
  const [mode, setMode] = useState<'whole' | 'items'>('whole');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, number | null>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState<'cash' | 'card' | 'bank_wallet'>('cash');
  const [reasonKey, setReasonKey] = useState<ReasonKey | ''>('');
  const [reasonText, setReasonText] = useState('');
  const [refundId, setRefundId] = useState(() => newId());
  const [approving, setApproving] = useState(false);
  const [pending, setPending] = useState(false);
  const savingRef = useRef(false);
  const [done, setDone] = useState<string | null>(null);
  const modeInitialized = useRef(false);

  const detail = useLiveQuery(() => billDetail(getDb(), saleId), [saleId]);
  const today = useLiveQuery(
    async () => businessDate(Date.now(), await shopTimeZone(getDb())),
    [],
  );
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
    setChecked({});
    setQty({});
    setRestock({});
    savingRef.current = false;
    modeInitialized.current = false;
  }, [open]);

  useEffect(() => {
    if (!detail || done || modeInitialized.current) return;
    modeInitialized.current = true;
    const groups = new Set<string>();
    for (const { line, keptMilli } of detail.lines)
      if (keptMilli > 0)
        groups.add(line.bundle_group ? String(line.bundle_group) : line.id);
    setMode(groups.size > 1 ? 'items' : 'whole');
  }, [detail, done]);

  const chosen: Choice[] = useMemo(
    () =>
      detail
        ? pickRefundChoices(detail.lines, mode, checked, qty, restock)
        : [],
    [detail, mode, checked, qty, restock],
  );
  const blocks = useMemo(() => {
    if (!detail) return [];
    const rows: Array<{
      kind: 'line' | 'bundle';
      key: string;
      lines: typeof detail.lines;
      remaining: number;
    }> = [];
    const seen = new Set<string>();
    for (const entry of detail.lines) {
      const group = entry.line.bundle_group;
      if (!group) {
        rows.push({
          kind: 'line',
          key: entry.line.id,
          lines: [entry],
          remaining: entry.keptMilli,
        });
        continue;
      }
      const id = String(group);
      if (seen.has(id)) continue;
      seen.add(id);
      const groupLines = detail.lines.filter(
        (row) => row.line.bundle_group === group,
      );
      rows.push({
        kind: 'bundle',
        key: id,
        lines: groupLines,
        remaining: Math.min(
          ...groupLines.map(({ line, keptMilli }) => {
            const perBundle = Number(line.bundle_component_qty_milli ?? 0);
            return perBundle > 0 ? Math.floor(keptMilli / perBundle) : 0;
          }),
        ),
      });
    }
    return rows;
  }, [detail]);

  const selectedBlocks = useMemo(() => {
    if (!detail) return 0;
    const keys = new Set<string>();
    for (const choice of chosen) {
      const line = detail.lines.find(
        (entry) => entry.line.id === choice.saleLineId,
      )?.line;
      keys.add(
        line?.bundle_group ? String(line.bundle_group) : choice.saleLineId,
      );
    }
    return keys.size;
  }, [chosen, detail]);

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
    if (!plan || !canSave || savingRef.current) return;
    savingRef.current = true;
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
      if (!printOn && method === 'cash' && plan.amount > 0)
        void kickDrawerForCash(db);
      setDone(String(result.refund.id));
      toast.push(t('office.refund.done'));
    } catch (err) {
      if (err instanceof RefundNotAllowedError) {
        toast.push(t(`office.refund.error_${err.code}`), 'error');
        return;
      }
      toast.push(t('errors.generic'), 'error');
    } finally {
      savingRef.current = false;
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

  // The refund route is shareable; BillDetail owns the same today/branch rule. Wait
  // for the shop's business date before rendering, or today's bill would flash while
  // the date is unknown and then disappear.
  const canViewBill =
    detail !== undefined &&
    detail !== null &&
    today !== undefined &&
    billVisible(
      role,
      support,
      can('report.view'),
      String(detail.sale.business_date) === today,
      branchId === null || String(detail.sale.branch_id) === branchId,
    );
  if (detail && today !== undefined && !canViewBill) {
    return (
      <Modal open={open} onOpenChange={(o) => !o && onClose()} title={title}>
        <p className="text-text-muted" data-testid="refund-no-access">
          {t('shell.no_access')}
        </p>
      </Modal>
    );
  }

  if (detail !== undefined && today === undefined) {
    return (
      <Modal open={open} onOpenChange={(o) => !o && onClose()} title={title}>
        <PageLoading compact />
      </Modal>
    );
  }

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
              void queueRefundPrint(getDb(), done)
                .then(() => toast.push(t('office.bill.print_queued')))
                .catch(() => toast.push(t('errors.generic'), 'error'));
            }}
          >
            {t('office.bill.print_refund')}
          </button>
          {reasonKey === 'exchange' && !readOnly && can('sale.create') ? (
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

  if (detail === null) {
    return (
      <Modal open={open} onOpenChange={(o) => !o && onClose()} title={title}>
        <p className="text-text-muted" data-testid="refund-not-found">
          {t('office.refund.not_found')}
        </p>
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
          {blocks.map((block) => {
            const first = block.lines[0];
            if (!first) return null;
            const selected = block.lines.some(({ line }) =>
              chosen.some((c) => c.saleLineId === line.id),
            );
            const amount = block.lines.reduce(
              (sum, { line }) =>
                sum +
                (plan?.lines.find((l) => l.saleLineId === line.id)?.amount ??
                  0),
              0,
            );
            if (block.kind === 'bundle') {
              const soldBundles = Number(first.line.bundle_qty ?? 0);
              const already = Math.max(0, soldBundles - block.remaining);
              const isChecked = checked[block.key] === true;
              return (
                <li
                  key={block.key}
                  className="flex flex-col gap-1 rounded-control border border-divider p-2"
                  data-testid="refund-bundle"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    {mode === 'items' ? (
                      <label className="flex min-h-11 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={block.remaining <= 0}
                          onChange={(e) => {
                            const next = e.target.checked;
                            setChecked((current) => ({
                              ...current,
                              [block.key]: next,
                            }));
                            setQty((current) => ({
                              ...current,
                              [block.key]: next
                                ? Math.max(1, block.remaining) * 1000
                                : 0,
                            }));
                          }}
                        />
                        <span className="font-medium">
                          {String(first.line.bundle_name ?? '')}
                        </span>
                        <span className="rounded-full bg-surface-2 px-1.5 text-caption font-medium text-text-muted">
                          {t('sell.bundle_pill')}
                        </span>
                      </label>
                    ) : (
                      <span className="flex items-center gap-2">
                        <span aria-hidden="true">•</span>
                        <span className="font-medium">
                          {String(first.line.bundle_name ?? '')}
                        </span>
                        <span className="rounded-full bg-surface-2 px-1.5 text-caption font-medium text-text-muted">
                          {t('sell.bundle_pill')}
                        </span>
                      </span>
                    )}
                    <span className="text-small text-text-muted">
                      {t('office.refund.bundle_sold', {
                        qty: soldBundles,
                        count: soldBundles,
                      })}
                      {already > 0
                        ? ` · ${t('office.refund.bundle_already', {
                            qty: already,
                          })}`
                        : ''}
                    </span>
                  </div>
                  {mode === 'items' && isChecked ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="w-36">
                          <QtyInput
                            label={t('office.refund.bundle_qty')}
                            unit="pc"
                            value={qty[block.key] ?? null}
                            onChange={(milli) =>
                              setQty((current) => ({
                                ...current,
                                [block.key]:
                                  milli === null
                                    ? null
                                    : Math.min(
                                        Math.max(0, milli),
                                        block.remaining * 1000,
                                      ),
                              }))
                            }
                          />
                        </div>
                        <p className="ms-auto text-end">
                          <MoneyText paisa={amount} />
                        </p>
                      </div>
                      <RestockOption
                        checked={restock[block.key] !== false}
                        onChange={(next) =>
                          setRestock((current) => ({
                            ...current,
                            [block.key]: next,
                          }))
                        }
                        label={t('office.refund.bundle_restock', {
                          count: block.lines.length,
                        })}
                        hint={t('office.refund.restock_hint')}
                      />
                    </div>
                  ) : selected ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-small text-text-muted">
                          {t('office.refund.bundle_qty_value', {
                            qty: block.remaining,
                          })}
                        </p>
                        <MoneyText paisa={amount} />
                      </div>
                      <RestockOption
                        checked={restock[block.key] !== false}
                        onChange={(next) =>
                          setRestock((current) => ({
                            ...current,
                            [block.key]: next,
                          }))
                        }
                        label={t('office.refund.bundle_restock', {
                          count: block.lines.length,
                        })}
                        hint={t('office.refund.restock_hint')}
                      />
                    </div>
                  ) : null}
                  <p className="text-small text-text-muted">
                    {t('office.refund.bundle_includes')}{' '}
                    {block.lines
                      .map(({ line, unit }) => {
                        const per = Number(
                          line.bundle_component_qty_milli ?? 0,
                        );
                        const componentUnit = isQtyUnit(unit) ? unit : 'pc';
                        return `${String(line.name_snapshot)} × ${formatQtyFromMilli(per, componentUnit)}`;
                      })
                      .join(' · ')}
                  </p>
                  <p className="text-caption text-text-muted">
                    {t('office.refund.bundle_whole_only')}
                  </p>
                </li>
              );
            }
            const { line, refundedMilli, keptMilli, unit } = first;
            const qtyUnit = isQtyUnit(unit) ? unit : 'pc';
            const isChecked = checked[line.id] === true;
            // Whole mode selects every remaining line; items mode only the checked
            // rows, whose draft may be empty while the cashier retypes it.
            const open = mode === 'whole' ? selected : isChecked;
            return (
              <li
                key={line.id}
                className="flex flex-col gap-1 rounded-control border border-divider p-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  {mode === 'items' ? (
                    <label className="flex min-h-11 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={keptMilli <= 0}
                        onChange={(e) => {
                          const next = e.target.checked;
                          setChecked((current) => ({
                            ...current,
                            [line.id]: next,
                          }));
                          setQty((current) => ({
                            ...current,
                            [line.id]: next ? keptMilli : 0,
                          }));
                        }}
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
                  <bdi className="text-small text-text-muted">
                    {t('office.refund.sold', {
                      qty: formatQtyFromMilli(Number(line.qty_milli), qtyUnit),
                    })}{' '}
                    {t(`unit.${qtyUnit}`)}
                    {refundedMilli > 0
                      ? ` · ${t('office.refund.already', {
                          qty: formatQtyFromMilli(refundedMilli, qtyUnit),
                        })}`
                      : ''}
                  </bdi>
                </div>
                {open ? (
                  <>
                    <div className="flex flex-wrap items-end gap-2">
                      {mode === 'items' ? (
                        <div className="w-36">
                          <QtyInput
                            label={t('office.refund.qty')}
                            unit={qtyUnit}
                            value={qty[line.id] ?? null}
                            onChange={(milli) =>
                              setQty((current) => ({
                                ...current,
                                [line.id]:
                                  milli === null
                                    ? null
                                    : Math.min(Math.max(0, milli), keptMilli),
                              }))
                            }
                          />
                        </div>
                      ) : (
                        <p className="text-small text-text-muted">
                          {t('office.refund.qty')}:{' '}
                          <bdi dir="ltr">
                            {formatQtyFromMilli(keptMilli, qtyUnit)}
                          </bdi>{' '}
                          {t(`unit.${qtyUnit}`)}
                        </p>
                      )}
                      <p className="ms-auto text-end">
                        <MoneyText paisa={amount} />
                      </p>
                    </div>
                    <RestockOption
                      checked={restock[line.id] !== false}
                      onChange={(next) =>
                        setRestock((current) => ({
                          ...current,
                          [line.id]: next,
                        }))
                      }
                      label={t('office.refund.restock')}
                      hint={t('office.refund.restock_hint')}
                    />
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {plan ? (
        <p
          className="flex items-center justify-between border-t border-divider px-2 py-1 text-small"
          data-testid="refund-running"
        >
          <span>{t('office.refund.selected', { count: selectedBlocks })}</span>
          <MoneyText paisa={plan.exact} />
        </p>
      ) : null}

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
            aria-label={t('office.refund.reason_other_label')}
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
              exact: money(plan?.exact ?? 0),
              paid: money(plan?.amount ?? 0),
              udhaar: money(plan?.udhaarPart ?? 0),
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
            amount: money(plan.udhaarPart),
            name: detail?.customer ? String(detail.customer.name) : '',
          })}
        </p>
      ) : null}

      {plan ? (
        <dl className="rounded-control border border-divider p-2 text-small">
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
          <div className="mt-1 flex justify-between gap-2 border-t border-divider pt-1 text-total font-semibold">
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

      <DialogFooter>
        <button
          type="button"
          className={`${buttonQuiet} max-md:flex-1`}
          onClick={onClose}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={`${buttonDanger} max-md:flex-1`}
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
            ? t('office.refund.button', {
                amount: money(plan.amount),
              })
            : plan && plan.udhaarPart > 0
              ? t('office.refund.button_khata', {
                  amount: money(plan.udhaarPart),
                })
              : t('office.refund.button_empty')}
        </button>
      </DialogFooter>
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
