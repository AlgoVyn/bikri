import {
  businessDate,
  formatQtyFromMilli,
  newId,
  saleLineFinal,
} from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  fieldClass,
  pageClass,
} from '../components/classes.ts';
import { ChevronLeftIcon, ChevronRightIcon } from '../components/icons.tsx';
import { useMasterDetailWide } from '../components/MasterDetail.tsx';
import { MoneyText, useDisplayMoney } from '../components/MoneyText.tsx';
import { PageActions } from '../components/PageActions.tsx';
import { PageLoading } from '../components/PageLoading';
import { useToast } from '../components/Toast.tsx';
import { useSubmitGuard } from '../components/useSubmitGuard.ts';
import {
  CART_IDS,
  type CartId,
  cartSignature,
  isEmptyCart,
  loadCarts,
} from '../data/cart.ts';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { queueSalePrint, receiptShareText, waLink } from '../data/receipt.ts';
import { queueRefundPrint } from '../data/refundReceipt.ts';
import { ReissueNotAllowedError, startReissue } from '../data/sale.ts';
import { type BillDetail as Bill, billDetail } from '../data/salesHistory.ts';
import { shopTimeZone } from '../data/shopTimeZone.ts';
import { VoidNotAllowedError, voidBlocker, voidSale } from '../data/voids.ts';
import { ReadOnlyError } from '../data/write.ts';
import { formatBusinessDate, formatTimestamp } from '../lib/date';
import { useRecordBack } from '../peek/recordBack.ts';
import { useOpenPeek } from '../peek/usePeekNavigation.ts';
import { kickDrawerForCash } from '../print/drawer.ts';
import {
  closeShareWindow,
  navigateShareWindow,
  openShareWindow,
} from '../print/shareWindow.ts';
import { isLatinName } from '../products/format.ts';
import { Modal } from '../sell/Modal.tsx';
import { useSellStore } from '../sell/sellStore.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { billVisible } from '../state/reportScope.ts';
import { ApprovalDialog } from './ApprovalDialog.tsx';
import {
  METHOD_KEYS,
  type ReasonKey,
  statusLabel,
  statusTone,
  VOID_REASONS,
} from './format.ts';

/** One entry of the bill's "More" menu; the component supplies the label and action. */
export type BillAction = { kind: 'refund' | 'void' | 'reissue' };

/**
 * The bill's extra actions. A void & reissue also writes a replacement bill, so it needs
 * `sale.create` on top of the void rules; a plain void stays on `sale.void` (UI-L5).
 */
export function billActions(input: {
  canRefund: boolean;
  canVoid: boolean;
  canCreate: boolean;
}): BillAction[] {
  const actions: BillAction[] = [];
  if (input.canRefund) actions.push({ kind: 'refund' });
  if (input.canVoid) {
    actions.push({ kind: 'void' });
    if (input.canCreate) actions.push({ kind: 'reissue' });
  }
  return actions;
}

/** Bill detail (screens/10). `/sales/:id`, with the refund modal at `/sales/:id/refund`. */
export function BillDetail({
  saleId,
  embedded = false,
}: {
  saleId: string;
  embedded?: boolean;
}) {
  const masterDetailWide = useMasterDetailWide();
  const { t, i18n } = useTranslation();
  const money = useDisplayMoney();
  const navigate = useNavigate();
  const recordBack = useRecordBack('/sales', 'nav.sales');
  const openPeek = useOpenPeek();
  const toast = useToast();
  const readOnly = useReadOnly();
  const { staff, role, can, support, branchId } = useCurrentStaff();
  const submitGuard = useSubmitGuard();
  const [voidOpen, setVoidOpen] = useState(false);
  const [reissueOpen, setReissueOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [approving, setApproving] = useState<'void' | 'reissue' | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{
    mode: 'void' | 'reissue';
    approvedBy: string;
  } | null>(null);

  const data = useLiveQuery(async () => {
    const db = getDb();
    const detail = await billDetail(db, saleId);
    if (!detail) return null;
    const timeZone = await shopTimeZone(db);
    const shop = await db.shop.get('shop');
    return {
      detail,
      timeZone,
      today: businessDate(Date.now(), timeZone),
      taxLabel: String(shop?.tax_label ?? '') || t('office.bill.tax_label'),
    };
  }, [saleId, i18n.language]);

  const print = async () => {
    if (!data) return;
    try {
      await queueSalePrint(getDb(), saleId, {
        reprint: data.detail.latestJob?.status === 'done',
      });
      toast.push(t('office.bill.print_queued'));
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };

  const share = async () => {
    if (!data) return;
    const shareWindow = openShareWindow();
    try {
      const { saleReceipt, receiptPng, downloadBlob } = await import(
        '../print/receiptFiles.ts'
      );
      const r = await saleReceipt(getDb(), saleId);
      if (!r) {
        closeShareWindow(shareWindow);
        return;
      }
      const png = await receiptPng(r);
      const phone = data.detail.customer?.phone
        ? String(data.detail.customer.phone)
        : null;
      const text = receiptShareText(r.input);
      const link = phone ? waLink(phone, text) : null;
      const file = new File([png], `${r.input.sale.invoiceNo}.png`, {
        type: 'image/png',
      });
      if (link) {
        downloadBlob(png, file.name);
        if (navigateShareWindow(shareWindow, link))
          toast.push(t('done.image_saved'));
        else toast.push(t('done.share_blocked'), 'error');
      } else {
        closeShareWindow(shareWindow);
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({
            files: [file],
            text,
            title: r.input.sale.invoiceNo,
          });
        } else {
          downloadBlob(png, file.name);
          toast.push(t('done.image_saved'));
        }
      }
    } catch (err) {
      closeShareWindow(shareWindow);
      if ((err as Error).name !== 'AbortError')
        toast.push(t('done.share_failed'), 'error');
    }
  };

  const pdf = async () => {
    if (!data) return;
    try {
      const { saleReceipt, receiptPdf, downloadBlob } = await import(
        '../print/receiptFiles.ts'
      );
      const r = await saleReceipt(getDb(), saleId);
      if (r) downloadBlob(await receiptPdf(r), `${r.input.sale.invoiceNo}.pdf`);
    } catch {
      toast.push(t('done.share_failed'), 'error');
    }
  };

  const canRefund =
    !readOnly &&
    data !== null &&
    data !== undefined &&
    data.detail.sale.status !== 'void' &&
    data.detail.sale.status !== 'refunded';
  const blocker = data
    ? voidBlocker(data.detail, role, data.today, can('sale.void'), false)
    : null;
  const canVoid =
    !readOnly &&
    data !== undefined &&
    data !== null &&
    (data.detail.sale.status === 'paid' ||
      data.detail.sale.status === 'part_refunded') &&
    data.detail.refunds.length === 0;

  const canViewBill =
    data !== null &&
    data !== undefined &&
    billVisible(
      role,
      support,
      can('report.view'),
      String(data.detail.sale.business_date) === data.today,
      branchId === null || String(data.detail.sale.branch_id) === branchId,
    );
  useHotkey(plainKey('p'), () => void print(), { enabled: canViewBill });
  useHotkey(
    plainKey('r'),
    () => {
      if (canRefund && canViewBill)
        void navigate({
          to: '/sales/$id/refund',
          params: { id: saleId },
          state: (previous) => ({ ...previous, bikriChild: 'bill' }),
        });
    },
    { enabled: canRefund && canViewBill },
  );

  if (data === null)
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.bill.not_found')}
      </p>
    );
  if (!data) return <PageLoading compact />;
  if (!canViewBill) {
    return <p className="p-4 text-text-muted">{t('shell.no_access')}</p>;
  }

  const { detail, timeZone } = data;
  const sale = detail.sale;
  const backdate = backdateInfo(detail.audit);
  const status = String(sale.status);
  const inclusive = sale.tax_inclusive === 1;
  const voidReason =
    detail.voidRow?.reason !== undefined ? String(detail.voidRow.reason) : '';
  const fullDate = formatTimestamp(
    Number(sale.created_at),
    i18n.language,
    timeZone,
  );

  const askVoid = (mode: 'void' | 'reissue') => {
    // An earlier-day void needs an owner approval, even for a manager or a cashier
    // with a `sale.void` grant (05 §5).
    if (!can('sale.void') || blocker === 'same_day') {
      setApproving(mode);
      return;
    }
    if (mode === 'void') setVoidOpen(true);
    else setReissueOpen(true);
  };

  const runVoid = async (reason: string, approvedBy: string | null) => {
    // Two rapid clicks would queue two `newId()` void rows before React re-renders.
    if (!submitGuard.lock()) return;
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      await voidSale(
        db,
        {
          voidId: newId(),
          saleId,
          reason,
          override: approvedBy ? { approved_by: approvedBy } : null,
        },
        ctx,
      );
      const { queueVoidPrint } = await import('../print/receiptFiles.ts');
      await queueVoidPrint(db, saleId).catch(() => undefined);
      if (
        detail.payments.some(
          (payment) =>
            payment.direction === 'in' &&
            payment.purpose === 'sale' &&
            payment.method === 'cash',
        )
      )
        void kickDrawerForCash(db);
      toast.push(t('office.bill.void_done'));
    } catch (err) {
      if (err instanceof VoidNotAllowedError) {
        toast.push(t(`office.bill.void_error_${err.code}`), 'error');
        return;
      }
      toast.push(
        err instanceof ReadOnlyError
          ? t('tenant.readOnly.blocked')
          : t('errors.generic'),
        'error',
      );
    } finally {
      submitGuard.unlock();
    }
  };

  const openReissue = async (reason: string, approvedBy: string | null) => {
    if (!submitGuard.lock()) return;
    try {
      const db = getDb();
      const carts = await loadCarts(db);
      const target: CartId | null =
        CART_IDS.find((id) => isEmptyCart(carts[id])) ?? null;
      if (!target) {
        toast.push(t('office.bill.carts_full'), 'error');
        return;
      }
      const cart = await startReissue(db, { saleId, cartId: target, reason });
      if (approvedBy) {
        cart.overrides = [
          ...(cart.overrides ?? []),
          {
            permission: 'sale.void',
            approved_by: approvedBy,
            approved_at: Date.now(),
            bound_cart: cartSignature(cart),
          },
        ];
        await db.carts.put(cart);
      }
      useSellStore.getState().setActive(target);
      void navigate({ to: '/sell' });
    } catch (err) {
      if (err instanceof ReissueNotAllowedError) {
        toast.push(t(`office.bill.reissue_error_${err.code}`), 'error');
        return;
      }
      toast.push(
        err instanceof ReadOnlyError
          ? t('tenant.readOnly.blocked')
          : t('errors.generic'),
        'error',
      );
    } finally {
      submitGuard.unlock();
    }
  };

  const paidBack = detail.payments
    .filter((p) => p.direction === 'in' && p.purpose === 'sale')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const returnQty = detail.lines
    .filter((line) => line.trackStock)
    .reduce((sum, line) => sum + Number(line.line.qty_milli), 0);
  const voidSummary = [
    paidBack > 0
      ? t('office.void.summary_paid', { amount: money(paidBack) })
      : null,
    returnQty > 0
      ? t('office.void.summary_stock', {
          qty: formatQtyFromMilli(returnQty, 'pc'),
        })
      : null,
    Number(sale.udhaar_amount) > 0
      ? t('office.void.summary_khata', {
          amount: money(Number(sale.udhaar_amount)),
          name: detail.customer ? String(detail.customer.name) : '',
        })
      : null,
  ].filter((line): line is string => line !== null);

  const onApproved = (approvedBy: string) => {
    const mode = approving;
    setApproving(null);
    if (mode === null) return;
    if (mode === 'void') setVoidOpen(true);
    else setReissueOpen(true);
    setPendingApproval({ mode, approvedBy });
  };

  const moreActions = billActions({
    canRefund,
    canVoid,
    // A reissue writes a new bill, so it needs `sale.create` as well (UI-L5).
    canCreate: can('sale.create'),
  }).map((action) => {
    if (action.kind === 'refund')
      return {
        label: t('office.bill.refund'),
        tone: 'danger' as const,
        onSelect: () =>
          void navigate({
            to: '/sales/$id/refund',
            params: { id: saleId },
            state: (previous) => ({ ...previous, bikriChild: 'bill' }),
          }),
      };
    if (action.kind === 'void')
      return {
        label: t('office.bill.void'),
        tone: 'danger' as const,
        onSelect: () => askVoid('void'),
      };
    return {
      label: t('office.bill.void_reissue'),
      tone: 'danger' as const,
      onSelect: () => askVoid('reissue'),
    };
  });
  return (
    <div
      className={
        embedded ? 'flex min-w-0 flex-col gap-3' : pageClass('focused')
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {recordBack ? (
          <Link
            to="/sales"
            aria-label={recordBack.label}
            title={recordBack.label}
            onClick={(event) => {
              event.preventDefault();
              recordBack.onActivate();
            }}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface text-text hover:bg-surface-2 max-lg:hidden"
          >
            <ChevronLeftIcon className="size-5 rtl:rotate-180" />
          </Link>
        ) : null}
        <h1 className="me-auto font-mono text-h1 font-semibold">
          {String(sale.invoice_no)}
        </h1>
        <span
          className={`rounded-full px-2 text-small font-medium ${statusTone(status)}`}
          data-testid="bill-status"
        >
          {statusLabel(t, status)}
        </span>
        {role === 'owner' ? (
          <button
            type="button"
            className="min-h-11 px-2 text-small text-text-muted underline underline-offset-2 hover:text-text"
            onClick={() => setAuditOpen(true)}
          >
            {t('office.bill.audit')}
          </button>
        ) : null}
      </div>

      {backdate ? (
        <p
          data-testid="bill-backdated"
          className="rounded-control border border-warning bg-warning-subtle p-2 text-small text-warning-subtle-ink"
        >
          {t('office.bill.recorded_late', {
            date: formatBusinessDate(String(sale.business_date), i18n.language),
            staff: detail.staffName,
            reason: backdate.reason,
          })}
        </p>
      ) : null}

      <PageActions
        primary={
          <button
            type="button"
            className={
              embedded && masterDetailWide ? buttonQuiet : buttonPrimary
            }
            onClick={() => void print()}
          >
            {t('office.bill.print')}
          </button>
        }
        secondary={
          <>
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => void share()}
            >
              {t('office.bill.share')}
            </button>
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => void pdf()}
            >
              {t('office.bill.pdf')}
            </button>
          </>
        }
        more={moreActions}
        primaryLast={!(embedded && masterDetailWide)}
      />

      {canVoid && blocker === 'same_day' ? (
        <p className="rounded-control bg-warning-subtle p-2 text-small text-warning-subtle-ink">
          {t('office.bill.void_same_day')}
        </p>
      ) : null}
      {detail.conflicts.length > 0 ? (
        <div
          role="alert"
          data-testid="bill-conflict"
          className="rounded-control bg-warning-subtle p-3 text-warning-subtle-ink"
        >
          <p className="font-medium">{t('office.bill.conflict_warning')}</p>
          <p className="text-small">{t('office.bill.conflict_body')}</p>
          <Link to="/settings/sync" className="underline">
            {t('office.bill.conflict_link')}
          </Link>
        </div>
      ) : null}
      {detail.refunds.length > 0 && status !== 'refunded' ? (
        <p className="rounded-control bg-surface-2 p-2 text-small text-text-muted">
          {t('office.bill.refund_the_rest')}
        </p>
      ) : null}
      {status === 'void' ? (
        <div className="rounded-card border-2 border-danger bg-danger-subtle p-3 text-danger-subtle-ink">
          <p className="text-title font-semibold">
            {t('office.bill.voided_title')}
          </p>
          <p>{t('office.bill.voided_body', { reason: voidReason })}</p>
          {detail.replacementSaleId ? (
            <Link
              to="/sales/$id"
              params={{ id: detail.replacementSaleId }}
              className="underline"
              onClick={(event) =>
                openPeek(
                  event,
                  { kind: 'bill', id: detail.replacementSaleId ?? '' },
                  {
                    key: 'peek.origin_bill',
                    params: { invoice: String(sale.invoice_no) },
                  },
                )
              }
            >
              {t('office.bill.replaced_by', {
                invoice: detail.replacementInvoiceNo ?? '',
              })}
            </Link>
          ) : null}
        </div>
      ) : null}
      {detail.replacedSaleId ? (
        <p className="text-small text-text-muted">
          {t('office.bill.replaces', {
            invoice: detail.replacedInvoiceNo ?? '',
          })}{' '}
          <Link
            to="/sales/$id"
            params={{ id: detail.replacedSaleId }}
            className="underline"
            onClick={(event) =>
              openPeek(
                event,
                { kind: 'bill', id: detail.replacedSaleId ?? '' },
                {
                  key: 'peek.origin_bill',
                  params: { invoice: String(sale.invoice_no) },
                },
              )
            }
          >
            {detail.replacedInvoiceNo}
          </Link>
        </p>
      ) : null}

      <dl
        className={`grid grid-cols-2 gap-2 rounded-card border border-border bg-surface p-3 text-small ${embedded ? '' : 'sm:grid-cols-4'}`}
      >
        <Meta label={t('office.bill.date')} value={fullDate} />
        <Meta label={t('office.bill.cashier')} value={detail.staffName} />
        <Meta label={t('office.bill.device')} value={detail.deviceName} />
        <Meta label={t('office.bill.branch')} value={detail.branchName} />
        <Meta
          label={t('office.bill.customer')}
          value={
            detail.customer ? (
              can('payment.receive') ? (
                <Link
                  to="/udhaar/$customerId"
                  params={{ customerId: String(detail.customer.id) }}
                  className="underline"
                  onClick={(event) =>
                    openPeek(
                      event,
                      { kind: 'customer', id: String(detail.customer?.id) },
                      {
                        key: 'peek.origin_bill',
                        params: { invoice: String(sale.invoice_no) },
                      },
                    )
                  }
                >
                  {String(detail.customer.name)}
                </Link>
              ) : (
                String(detail.customer.name)
              )
            ) : (
              t('office.sales.walk_in')
            )
          }
        />
      </dl>

      <section className="rounded-card border border-border bg-surface">
        <table className="w-full text-small">
          <thead>
            <tr className="border-b border-border text-start text-text-muted">
              <th className="p-2 text-start">{t('office.bill.col_name')}</th>
              <th className="p-2 text-start">{t('office.bill.col_qty')}</th>
              <th
                className={
                  embedded ? 'hidden' : 'hidden p-2 text-start sm:table-cell'
                }
              >
                {t('office.bill.col_price')}
              </th>
              <th
                className={
                  embedded ? 'hidden' : 'hidden p-2 text-start sm:table-cell'
                }
              >
                {t('office.bill.col_discount')}
              </th>
              <th className="p-2 text-start">{t('office.bill.col_total')}</th>
              <th
                className={
                  embedded ? 'hidden' : 'hidden p-2 text-start sm:table-cell'
                }
              >
                {t('office.bill.col_refunded')}
              </th>
              <th
                className={
                  embedded ? 'hidden' : 'hidden p-2 text-start sm:table-cell'
                }
              >
                {t('office.bill.col_kept')}
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map(
              (
                {
                  line,
                  refundedMilli,
                  keptMilli,
                  unit,
                  product,
                  bundleProduct,
                  note,
                },
                lineIndex,
              ) => {
                const qty = Number(line.qty_milli);
                const group = line.bundle_group
                  ? String(line.bundle_group)
                  : null;
                const firstOfGroup =
                  group !== null &&
                  detail.lines.findIndex(
                    (row) => String(row.line.bundle_group ?? '') === group,
                  ) === lineIndex;
                return (
                  <Fragment key={line.id}>
                    {firstOfGroup ? (
                      <tr className="border-b border-border bg-surface-2">
                        <td colSpan={7} className="p-2">
                          <span className="flex flex-wrap items-center gap-2 font-medium">
                            <span>
                              {t('office.bill.bundle_label')}{' '}
                              <ProductNameLink
                                id={bundleProduct?.id ?? null}
                                name={String(line.bundle_name ?? '')}
                                latin={isLatinName(
                                  String(line.bundle_name ?? ''),
                                )}
                                saleInvoice={String(sale.invoice_no)}
                              />
                            </span>
                            <span className="rounded-full bg-surface px-1.5 text-caption font-medium text-text-muted">
                              {t('sell.bundle_pill')}
                            </span>
                            <span className="ms-auto text-small text-text-muted">
                              {Number(line.bundle_qty)} ×{' '}
                              <MoneyText
                                paisa={
                                  Number(line.bundle_price) -
                                  Number(line.bundle_discount ?? 0)
                                }
                              />
                            </span>
                          </span>
                        </td>
                      </tr>
                    ) : null}
                    <tr className="border-b border-border last:border-0">
                      <td className={group ? 'p-2 ps-6' : 'p-2'}>
                        <ProductNameLink
                          id={product?.id ?? null}
                          name={String(line.name_snapshot)}
                          latin={isLatinName(String(line.name_snapshot))}
                          saleInvoice={String(sale.invoice_no)}
                          className="block"
                        />
                        {note ? (
                          <span
                            className="block text-small text-text-muted"
                            data-testid="bill-line-note"
                          >
                            {t('office.bill.line_note')}:{' '}
                            <bdi
                              dir="auto"
                              className={isLatinName(note) ? '' : 'font-urdu'}
                            >
                              {note}
                            </bdi>
                          </span>
                        ) : null}
                        {embedded ? null : (
                          <span className="block text-text-muted sm:hidden">
                            {t('office.bill.qty_price', {
                              qty: `${formatQtyFromMilli(qty, unit)} ${t(`unit.${unit}`)}`,
                              price: money(Number(line.unit_price)),
                            })}
                          </span>
                        )}
                        {!embedded || refundedMilli > 0 ? (
                          <span
                            className={
                              embedded
                                ? 'block text-small text-text-muted'
                                : 'block text-small text-text-muted sm:hidden'
                            }
                          >
                            {refundedMilli > 0
                              ? `${t('office.bill.col_refunded')}: ${formatQtyFromMilli(refundedMilli, unit)} · `
                              : ''}
                            {`${t('office.bill.col_kept')}: ${formatQtyFromMilli(keptMilli, unit)}`}
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2 text-start tabular-nums">
                        <bdi dir="ltr">{formatQtyFromMilli(qty, unit)}</bdi>{' '}
                        {t(`unit.${unit}`)}
                      </td>
                      <td
                        className={
                          embedded
                            ? 'hidden'
                            : 'hidden p-2 text-start sm:table-cell'
                        }
                      >
                        <MoneyText paisa={Number(line.unit_price)} />
                      </td>
                      <td
                        className={
                          embedded
                            ? 'hidden'
                            : 'hidden p-2 text-start sm:table-cell'
                        }
                      >
                        <MoneyText paisa={Number(line.discount ?? 0)} />
                      </td>
                      <td className="p-2 text-start">
                        <MoneyText
                          paisa={saleLineFinal(
                            {
                              net: Number(line.net),
                              bill_discount_alloc: Number(
                                line.bill_discount_alloc,
                              ),
                              tax_alloc: Number(line.tax_alloc),
                              rounding_alloc: Number(line.rounding_alloc),
                            },
                            inclusive,
                          )}
                        />
                      </td>
                      <td
                        className={
                          embedded
                            ? 'hidden'
                            : 'hidden p-2 text-start sm:table-cell'
                        }
                      >
                        {refundedMilli > 0
                          ? formatQtyFromMilli(refundedMilli, unit)
                          : '—'}
                      </td>
                      <td
                        className={
                          embedded
                            ? 'hidden'
                            : 'hidden p-2 text-start sm:table-cell'
                        }
                      >
                        {formatQtyFromMilli(keptMilli, unit)}
                      </td>
                    </tr>
                  </Fragment>
                );
              },
            )}
          </tbody>
        </table>
      </section>

      {String(sale.note ?? '').trim() !== '' ? (
        <p
          data-testid="bill-remark"
          className="rounded-control bg-surface-2 p-2 text-small"
        >
          <span className="font-medium">{t('office.bill.remark')}: </span>
          <span
            dir="auto"
            className={`whitespace-pre-wrap break-words ${
              isLatinName(String(sale.note)) ? '' : 'font-urdu'
            }`}
          >
            {String(sale.note)}
          </span>
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="rounded-card border border-border bg-surface p-3 text-small">
          <h2 className="mb-2 text-title font-semibold">
            {t('office.bill.totals')}
          </h2>
          <Row
            label={t('office.bill.totals_subtotal')}
            value={<MoneyText paisa={Number(sale.subtotal)} />}
          />
          {Number(sale.item_discount_total) > 0 ? (
            <Row
              label={t('office.bill.totals_item_discount')}
              value={<MoneyText paisa={Number(sale.item_discount_total)} />}
            />
          ) : null}
          {Number(sale.bundle_discount_total ?? 0) > 0 ? (
            <Row
              label={t('office.bill.totals_bundle_discount')}
              value={<MoneyText paisa={Number(sale.bundle_discount_total)} />}
            />
          ) : null}
          {Number(sale.bill_discount) > 0 ? (
            <Row
              label={t('office.bill.totals_bill_discount')}
              value={<MoneyText paisa={Number(sale.bill_discount)} />}
            />
          ) : null}
          {!inclusive && Number(sale.tax) > 0 ? (
            <Row
              label={`${data.taxLabel} (${Number(sale.tax_rate_bp) / 100}%)`}
              value={<MoneyText paisa={Number(sale.tax)} />}
            />
          ) : null}
          {Number(sale.rounding) !== 0 ? (
            <Row
              label={t('office.bill.totals_rounding')}
              value={<MoneyText paisa={Number(sale.rounding)} />}
            />
          ) : null}
          <Row
            label={t('office.bill.totals_total')}
            value={<MoneyText paisa={Number(sale.total)} />}
            strong
          />
          {inclusive && Number(sale.tax) > 0 ? (
            <Row
              label={t('office.bill.totals_includes', {
                label: data.taxLabel,
              })}
              value={<MoneyText paisa={Number(sale.tax)} />}
            />
          ) : null}
          <Row
            label={t('office.bill.totals_paid')}
            value={<MoneyText paisa={Number(sale.paid_total)} />}
          />
          {Number(sale.udhaar_amount) > 0 ? (
            <Row
              label={t('office.bill.totals_udhaar')}
              value={<MoneyText paisa={Number(sale.udhaar_amount)} />}
            />
          ) : null}
          {Number(sale.change_given) > 0 ? (
            <Row
              label={t('office.bill.totals_change')}
              value={<MoneyText paisa={Number(sale.change_given)} />}
            />
          ) : null}
        </section>

        <section className="rounded-card border border-border bg-surface p-3 text-small">
          <h2 className="mb-2 text-title font-semibold">
            {t('office.bill.payments')}
          </h2>
          {detail.payments.filter((p) => p.direction === 'in').length === 0 ? (
            <p className="text-text-muted">{t('office.bill.no_payments')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {detail.payments
                .filter((p) => p.direction === 'in')
                .map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap justify-between gap-2"
                  >
                    <span>
                      {t(
                        METHOD_KEYS[
                          String(p.method) as keyof typeof METHOD_KEYS
                        ] ?? 'payment.cash',
                      )}
                      {p.reference ? (
                        <span className="block text-text-muted">
                          {String(p.reference)}
                        </span>
                      ) : null}
                      {Number(p.cash_tendered ?? 0) > 0 ? (
                        <span className="block text-small text-text-muted">
                          {t('office.bill.tendered', {
                            amount: money(Number(p.cash_tendered)),
                          })}{' '}
                          ·{' '}
                          {t('office.bill.change', {
                            amount: money(Number(p.change_given ?? 0)),
                          })}
                        </span>
                      ) : null}
                    </span>
                    <MoneyText paisa={Number(p.amount)} />
                  </li>
                ))}
            </ul>
          )}
          {detail.payments.filter((p) => p.direction === 'out').length > 0 ? (
            <>
              <h3 className="mb-1 mt-3 font-medium">
                {t('office.bill.money_out')}
              </h3>
              <ul className="flex flex-col gap-1">
                {detail.payments
                  .filter((p) => p.direction === 'out')
                  .map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-wrap justify-between gap-2"
                    >
                      <span>
                        {String(p.purpose) === 'void'
                          ? t('office.bill.void_money_out')
                          : t('office.bill.refund_money_out')}
                      </span>
                      <MoneyText paisa={Number(p.amount)} />
                    </li>
                  ))}
              </ul>
            </>
          ) : null}
        </section>
      </div>

      {detail.refunds.length > 0 ? (
        <section className="rounded-card border border-border bg-surface p-3 text-small">
          <h2 className="mb-2 text-title font-semibold">
            {t('office.bill.refunds')}
          </h2>
          <ul className="flex flex-col gap-3">
            {detail.refunds.map(({ refund, lines, staffName }) => (
              <li
                key={refund.id}
                className="rounded-control border border-border p-2"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span>
                    {formatTimestamp(
                      Number(refund.created_at),
                      i18n.language,
                      timeZone,
                    )}
                    {staffName ? ` · ${staffName}` : ''}
                  </span>
                  <span className="font-medium">
                    <MoneyText paisa={Number(refund.amount)} />
                  </span>
                </div>
                <p className="text-text-muted">
                  {t('office.bill.refund_reason', {
                    reason: String(refund.reason),
                  })}
                </p>
                <ul className="my-1 text-text-muted">
                  {lines.map((rl) => {
                    const saleLine = detail.lines.find(
                      (l) => l.line.id === rl.sale_line_id,
                    );
                    return (
                      <li key={rl.id}>
                        {String(saleLine?.line.name_snapshot ?? '')} ×{' '}
                        <bdi dir="ltr">
                          {formatQtyFromMilli(
                            Number(rl.qty_milli),
                            saleLine?.unit ?? 'pc',
                          )}
                        </bdi>
                      </li>
                    );
                  })}
                </ul>
                {Number(refund.udhaar_part) > 0 ? (
                  <p>
                    {t('office.bill.refund_khata', {
                      amount: money(Number(refund.udhaar_part)),
                    })}
                  </p>
                ) : null}
                {refund.method ? (
                  <p className="text-text-muted">
                    {t(
                      METHOD_KEYS[
                        String(refund.method) as keyof typeof METHOD_KEYS
                      ] ?? 'payment.cash',
                    )}
                    {Number(refund.rounding) !== 0
                      ? ` · ${t('office.bill.refund_rounding', {
                          amount: money(Number(refund.rounding)),
                        })}`
                      : ''}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="mt-1 inline-flex min-h-11 items-center underline"
                  onClick={() => {
                    void queueRefundPrint(getDb(), String(refund.id), {
                      reprint: true,
                    })
                      .then(() => toast.push(t('office.bill.print_queued')))
                      .catch(() => toast.push(t('errors.generic'), 'error'));
                  }}
                >
                  {t('office.bill.print_refund')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <VoidDialog
        summary={voidSummary}
        open={voidOpen}
        onOpenChange={(open) => {
          setVoidOpen(open);
          if (!open) setPendingApproval(null);
        }}
        onConfirm={(reason) => {
          setVoidOpen(false);
          const approvedBy =
            pendingApproval?.mode === 'void'
              ? pendingApproval.approvedBy
              : null;
          setPendingApproval(null);
          void runVoid(reason, approvedBy);
        }}
        title={t('office.void.title')}
        body={t('office.void.body')}
        confirm={t('office.void.confirm')}
      />
      <VoidDialog
        open={reissueOpen}
        onOpenChange={(open) => {
          setReissueOpen(open);
          if (!open) setPendingApproval(null);
        }}
        onConfirm={(reason) => {
          setReissueOpen(false);
          const approvedBy =
            pendingApproval?.mode === 'reissue'
              ? pendingApproval.approvedBy
              : null;
          setPendingApproval(null);
          void openReissue(reason, approvedBy);
        }}
        title={t('office.void.reissue_title')}
        body={t('office.void.reissue_body')}
        confirm={t('office.void.reissue_confirm')}
      />
      <ApprovalDialog
        open={approving !== null}
        onOpenChange={(o) => {
          if (!o) setApproving(null);
        }}
        permission="sale.void"
        roles={
          String(sale.business_date) !== data.today ? ['owner'] : undefined
        }
        body={t('sell.override_sale_void')}
        onApproved={onApproved}
      />
      <AuditDialog
        open={auditOpen}
        onOpenChange={setAuditOpen}
        audit={detail.audit}
        timeZone={timeZone}
      />
    </div>
  );
}

function ProductNameLink({
  id,
  name,
  latin,
  saleInvoice,
  className = '',
}: {
  id: string | null;
  name: string;
  latin: boolean;
  saleInvoice: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const openPeek = useOpenPeek();
  const classes = `data-name ${latin ? 'ltr-name' : ''} ${className}`.trim();
  if (!id) return <span className={classes}>{name}</span>;
  return (
    <Link
      to="/products/$id"
      params={{ id }}
      aria-label={t('office.bill.open_product', { name })}
      className={`${classes} underline decoration-dotted underline-offset-2 hover:decoration-solid`}
      onClick={(event) =>
        openPeek(
          event,
          { kind: 'product', id },
          {
            key: 'peek.origin_bill',
            params: { invoice: saleInvoice },
          },
        )
      }
    >
      {name}
      <ChevronRightIcon
        aria-hidden="true"
        className="ms-1 inline size-3 text-text-muted rtl:rotate-180"
      />
    </Link>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-text-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap items-baseline justify-between gap-2 ${strong ? 'border-t border-border pt-1 font-semibold' : ''}`}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function VoidDialog({
  open,
  onOpenChange,
  onConfirm,
  title,
  body,
  confirm,
  summary = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  title: string;
  body: string;
  confirm: string;
  summary?: readonly string[];
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ReasonKey | 'other' | ''>('');
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) {
      setReason('');
      setText('');
    }
  }, [open]);
  const reasons = VOID_REASONS;
  const label =
    reason === 'other'
      ? text.trim()
      : reason
        ? t(`office.void.reason_${reason}`)
        : '';
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <p>{body}</p>
      {summary.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 ps-5 text-small">
          {summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <fieldset>
        <legend className="mb-1 text-small">{t('office.void.reason')}</legend>
        <div className="flex flex-wrap gap-2">
          {reasons.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={reason === r}
              className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
              onClick={() => setReason(r)}
            >
              {t(`office.void.reason_${r}`)}
            </button>
          ))}
        </div>
      </fieldset>
      {reason === 'other' ? (
        <label className="flex flex-col gap-1 text-small">
          {t('office.void.reason_other_label')}
          <input
            className={fieldClass}
            maxLength={120}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={buttonQuiet}
          onClick={() => onOpenChange(false)}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={buttonDanger}
          disabled={label.length === 0 || label.length > 120}
          onClick={() => {
            onConfirm(label);
            setReason('');
            setText('');
          }}
        >
          {confirm}
        </button>
      </div>
    </Modal>
  );
}

function backdateInfo(audit: Bill['audit']): { reason: string } | null {
  const row = audit.find((entry) => entry.action === 'sale_backdated');
  if (!row) return null;
  try {
    const after = JSON.parse(String(row.after_json ?? '{}')) as {
      reason?: unknown;
    };
    return { reason: typeof after.reason === 'string' ? after.reason : '' };
  } catch {
    return { reason: '' };
  }
}

function AuditDialog({
  open,
  onOpenChange,
  audit,
  timeZone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audit: Bill['audit'];
  timeZone: string;
}) {
  const { t, i18n } = useTranslation();
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('office.bill.audit')}
      wide
    >
      {audit.length === 0 ? (
        <p>{t('office.bill.audit_empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-small">
          {audit
            .slice()
            .sort((a, b) => Number(b.created_at) - Number(a.created_at))
            .map((row) => (
              <li
                key={row.id}
                className="rounded-control border border-border p-2"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{String(row.action)}</span>
                  <span className="text-text-muted">
                    {formatTimestamp(
                      Number(row.created_at),
                      i18n.language,
                      timeZone,
                    )}
                  </span>
                </div>
                {row.after_json ? (
                  <pre className="mt-1 break-all whitespace-pre-wrap text-text-muted">
                    {String(row.after_json)}
                  </pre>
                ) : null}
              </li>
            ))}
        </ul>
      )}
    </Modal>
  );
}
