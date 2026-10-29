import { businessDate, formatMoney, newId, saleLineFinal } from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonDanger,
  buttonDangerQuiet,
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
import { MoneyText } from '../components/MoneyText.tsx';
import { useToast } from '../components/Toast.tsx';
import { CART_IDS, type CartId, isEmptyCart, loadCarts } from '../data/cart.ts';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { queueSalePrint, receiptShareText, waLink } from '../data/receipt.ts';
import { queueRefundPrint } from '../data/refundReceipt.ts';
import { ReissueNotAllowedError, startReissue } from '../data/sale.ts';
import {
  type BillDetail as Bill,
  billDetail,
  shopTimeZone,
} from '../data/salesHistory.ts';
import { VoidNotAllowedError, voidBlocker, voidSale } from '../data/voids.ts';
import { Modal } from '../sell/Modal.tsx';
import { useSellStore } from '../sell/sellStore.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { ApprovalDialog } from './ApprovalDialog.tsx';
import {
  localeOf,
  METHOD_KEYS,
  type ReasonKey,
  statusLabel,
  statusTone,
  VOID_REASONS,
} from './format.ts';

/** Bill detail (screens/10). `/sales/:id`, with the refund modal at `/sales/:id/refund`. */
export function BillDetail({
  saleId,
  embedded = false,
}: {
  saleId: string;
  embedded?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const readOnly = useReadOnly();
  const { staff, role, can } = useCurrentStaff();
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
    await queueSalePrint(getDb(), saleId, {
      reprint: data.detail.latestJob?.status === 'done',
    });
    toast.push(t('office.bill.print_queued'));
  };

  const share = async () => {
    if (!data) return;
    try {
      const { saleReceipt, receiptPng, downloadBlob } = await import(
        '../print/receiptFiles.ts'
      );
      const r = await saleReceipt(getDb(), saleId);
      if (!r) return;
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
        window.open(link, '_blank', 'noopener');
        toast.push(t('done.image_saved'));
      } else if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          text,
          title: r.input.sale.invoiceNo,
        });
      } else {
        downloadBlob(png, file.name);
        toast.push(t('done.image_saved'));
      }
    } catch (err) {
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

  useHotkey(plainKey('p'), () => void print(), { enabled: Boolean(data) });
  useHotkey(
    plainKey('r'),
    () => {
      if (canRefund)
        void navigate({ to: '/sales/$id/refund', params: { id: saleId } });
    },
    { enabled: canRefund },
  );

  if (data === null)
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.bill.not_found')}
      </p>
    );
  if (!data) return <p className="sr-only">{t('common.loading')}</p>;

  const { detail, timeZone } = data;
  const sale = detail.sale;
  const status = String(sale.status);
  const inclusive = sale.tax_inclusive === 1;
  const voidReason =
    detail.voidRow?.reason !== undefined ? String(detail.voidRow.reason) : '';
  const fullDate = new Intl.DateTimeFormat(localeOf(i18n.language), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(Number(sale.created_at));

  const askVoid = (mode: 'void' | 'reissue') => {
    // A manager's previous-day void needs another manager/owner to approve it (05 §5).
    if (blocker === 'same_day' && role !== 'manager') {
      toast.push(t('office.bill.void_same_day'), 'error');
      return;
    }
    if (!can('sale.void') || blocker === 'same_day') {
      setApproving(mode);
      return;
    }
    if (mode === 'void') setVoidOpen(true);
    else setReissueOpen(true);
  };

  const runVoid = async (reason: string, approvedBy: string | null) => {
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
      toast.push(t('office.bill.void_done'));
    } catch (err) {
      if (err instanceof VoidNotAllowedError) {
        toast.push(t(`office.bill.void_error_${err.code}`), 'error');
        return;
      }
      throw err;
    }
  };

  const openReissue = async (reason: string, approvedBy: string | null) => {
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
          { permission: 'sale.void', approved_by: approvedBy },
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
      throw err;
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
      ? t('office.void.summary_paid', { amount: formatMoney(paidBack) })
      : null,
    returnQty > 0
      ? t('office.void.summary_stock', { qty: returnQty / 1000 })
      : null,
    Number(sale.udhaar_amount) > 0
      ? t('office.void.summary_khata', {
          amount: formatMoney(Number(sale.udhaar_amount)),
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
  return (
    <div
      className={
        embedded
          ? 'flex min-w-0 flex-col gap-3'
          : 'mx-auto flex max-w-4xl flex-col gap-3 p-4'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to="/sales"
          aria-label={t('office.bill.back')}
          title={t('office.bill.back')}
          className={
            embedded
              ? 'inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface text-text hover:bg-surface-2'
              : buttonQuiet
          }
        >
          {embedded ? (
            <span
              aria-hidden="true"
              className="text-title leading-none rtl:rotate-180"
            >
              ‹
            </span>
          ) : (
            t('office.bill.back')
          )}
        </Link>
        <h1 className="me-auto font-mono text-h1 font-semibold">
          {String(sale.invoice_no)}
        </h1>
        <span
          className={`rounded-full px-2 text-small font-medium ${statusTone(status)}`}
          data-testid="bill-status"
        >
          {statusLabel(t, status)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`${buttonQuiet} gap-2`}
          onClick={() => void print()}
        >
          {t('office.bill.print')}
        </button>
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
        {canRefund ? (
          <button
            type="button"
            className={`${buttonPrimary} gap-2`}
            onClick={() =>
              void navigate({
                to: '/sales/$id/refund',
                params: { id: saleId },
              })
            }
          >
            {t('office.bill.refund')}
          </button>
        ) : null}
        {canVoid ? (
          <>
            <button
              type="button"
              className={buttonDangerQuiet}
              onClick={() => askVoid('void')}
            >
              {t('office.bill.void')}
            </button>
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => askVoid('reissue')}
            >
              {t('office.bill.void_reissue')}
            </button>
          </>
        ) : null}
        {role === 'owner' ? (
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => setAuditOpen(true)}
          >
            {t('office.bill.audit')}
          </button>
        ) : null}
      </div>

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
          >
            {detail.replacedInvoiceNo}
          </Link>
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-2 rounded-card border border-border bg-surface p-3 text-small sm:grid-cols-4">
        <Meta label={t('office.bill.date')} value={fullDate} />
        <Meta label={t('office.bill.cashier')} value={detail.staffName} />
        <Meta label={t('office.bill.device')} value={detail.deviceName} />
        <Meta label={t('office.bill.branch')} value={detail.branchName} />
        <Meta
          label={t('office.bill.customer')}
          value={
            detail.customer ? (
              <Link
                to="/udhaar/$customerId"
                params={{ customerId: String(detail.customer.id) }}
                className="underline"
              >
                {String(detail.customer.name)}
              </Link>
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
              <th className="p-2 text-end">{t('office.bill.col_qty')}</th>
              <th className="hidden p-2 text-end sm:table-cell">
                {t('office.bill.col_price')}
              </th>
              <th className="hidden p-2 text-end sm:table-cell">
                {t('office.bill.col_discount')}
              </th>
              <th className="p-2 text-end">{t('office.bill.col_total')}</th>
              <th className="hidden p-2 text-end sm:table-cell">
                {t('office.bill.col_refunded')}
              </th>
              <th className="hidden p-2 text-end sm:table-cell">
                {t('office.bill.col_kept')}
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map(({ line, refundedMilli, keptMilli, unit }) => {
              const qty = Number(line.qty_milli);
              return (
                <tr
                  key={line.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="p-2">
                    <span className="ltr-name block">
                      {String(line.name_snapshot)}
                    </span>
                    <span className="block text-text-muted sm:hidden">
                      {t('office.bill.qty_price', {
                        qty: `${qty / 1000} ${t(`unit.${unit}`)}`,
                        price: formatMoney(Number(line.unit_price)),
                      })}
                    </span>
                    <span className="block text-small text-text-muted sm:hidden">
                      {refundedMilli > 0
                        ? `${t('office.bill.col_refunded')}: ${refundedMilli / 1000} · `
                        : ''}
                      {`${t('office.bill.col_kept')}: ${keptMilli / 1000}`}
                    </span>
                  </td>
                  <td className="p-2 text-end font-mono">
                    {qty / 1000} {t(`unit.${unit}`)}
                  </td>
                  <td className="hidden p-2 text-end sm:table-cell">
                    <MoneyText paisa={Number(line.unit_price)} />
                  </td>
                  <td className="hidden p-2 text-end sm:table-cell">
                    <MoneyText paisa={Number(line.discount ?? 0)} />
                  </td>
                  <td className="p-2 text-end">
                    <MoneyText
                      paisa={saleLineFinal(
                        {
                          net: Number(line.net),
                          bill_discount_alloc: Number(line.bill_discount_alloc),
                          tax_alloc: Number(line.tax_alloc),
                          rounding_alloc: Number(line.rounding_alloc),
                        },
                        inclusive,
                      )}
                    />
                  </td>
                  <td className="hidden p-2 text-end sm:table-cell">
                    {refundedMilli > 0 ? refundedMilli / 1000 : '—'}
                  </td>
                  <td className="hidden p-2 text-end sm:table-cell">
                    {keptMilli / 1000}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="rounded-card border border-border bg-surface p-3 text-small">
          <h2 className="mb-2 text-title">{t('office.bill.totals')}</h2>
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
          <h2 className="mb-2 text-title">{t('office.bill.payments')}</h2>
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
                            amount: formatMoney(Number(p.cash_tendered)),
                          })}{' '}
                          ·{' '}
                          {t('office.bill.change', {
                            amount: formatMoney(Number(p.change_given ?? 0)),
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
          <h2 className="mb-2 text-title">{t('office.bill.refunds')}</h2>
          <ul className="flex flex-col gap-3">
            {detail.refunds.map(({ refund, lines, staffName }) => (
              <li
                key={refund.id}
                className="rounded-control border border-border p-2"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span>
                    {new Intl.DateTimeFormat(localeOf(i18n.language), {
                      dateStyle: 'short',
                      timeStyle: 'short',
                      timeZone,
                    }).format(Number(refund.created_at))}
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
                  {lines.map((rl) => (
                    <li key={rl.id}>
                      {String(
                        detail.lines.find((l) => l.line.id === rl.sale_line_id)
                          ?.line.name_snapshot ?? '',
                      )}{' '}
                      × {Number(rl.qty_milli) / 1000}
                    </li>
                  ))}
                </ul>
                {Number(refund.udhaar_part) > 0 ? (
                  <p>
                    {t('office.bill.refund_khata', {
                      amount: formatMoney(Number(refund.udhaar_part)),
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
                          amount: formatMoney(Number(refund.rounding)),
                        })}`
                      : ''}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="mt-1 underline"
                  onClick={() => {
                    void queueRefundPrint(getDb(), String(refund.id)).then(() =>
                      toast.push(t('office.bill.print_queued')),
                    );
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
                    {new Intl.DateTimeFormat(localeOf(i18n.language), {
                      dateStyle: 'short',
                      timeStyle: 'short',
                      timeZone,
                    }).format(Number(row.created_at))}
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
