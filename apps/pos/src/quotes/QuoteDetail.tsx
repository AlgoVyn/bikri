import type { SyncedRow } from '@bikri/db';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonDangerQuiet,
  buttonPrimary,
  buttonQuiet,
} from '../components/classes.ts';
import { DialogFooter } from '../components/DialogFooter.tsx';
import { ChevronLeftIcon, ChevronRightIcon } from '../components/icons.tsx';
import { useMasterDetailWide } from '../components/MasterDetail.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { OverrideDialog } from '../components/OverrideDialog.tsx';
import {
  type PageActionItem,
  PageActions,
} from '../components/PageActions.tsx';
import { useToast } from '../components/Toast.tsx';
import { saleApprovers } from '../data/cart.ts';
import { getDb } from '../data/db.ts';
import {
  cancelQuote,
  queueQuotePrint,
  quoteShareText,
  quoteStatus,
  startQuoteCart,
} from '../data/quotes.ts';
import { waLink } from '../data/receipt.ts';
import { useBusinessDates } from '../data/useBusinessDates.ts';
import { useShopTimeZone } from '../data/useShopTimeZone.ts';
import { formatBusinessDate } from '../lib/date.ts';
import { useRecordBack } from '../peek/recordBack.ts';
import { useOpenPeek } from '../peek/usePeekNavigation.ts';
import {
  closeShareWindow,
  navigateShareWindow,
  openShareWindow,
} from '../print/shareWindow.ts';
import { Modal } from '../sell/Modal.tsx';
import { useSellStore } from '../sell/sellStore.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useIsDesktop } from '../shell/useIsDesktop.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';

type Loaded = {
  quote: SyncedRow;
  lines: SyncedRow[];
  staffName: string;
  deviceName: string;
  shopName: string;
  branchName: string;
  convertedInvoice: string | null;
};

export function QuoteDetail({ quoteId }: { quoteId: string }) {
  const { t } = useTranslation();
  const data = useLiveQuery(async (): Promise<Loaded | null> => {
    const db = getDb();
    const quote = await db.quotations.get(quoteId);
    if (!quote) return null;
    const lines = (
      await db.quotation_lines
        .where('quote_id')
        .equals(quoteId)
        .sortBy('line_no')
    ).filter(
      (line: SyncedRow) =>
        line.deleted_at === null || line.deleted_at === undefined,
    );
    const staff = quote.staff_id
      ? await db.staff.get(String(quote.staff_id))
      : undefined;
    const device = quote.device_id
      ? await db.devices.get(String(quote.device_id))
      : undefined;
    const shop = await db.shop.get('shop');
    const branch = quote.branch_id
      ? await db.branches.get(String(quote.branch_id))
      : undefined;
    const sale = quote.converted_sale_id
      ? await db.sales.get(String(quote.converted_sale_id))
      : undefined;
    return {
      quote,
      lines,
      staffName: staff ? String(staff.name) : '',
      deviceName: device ? String(device.name) : '',
      shopName: shop ? String(shop.name) : '',
      branchName: branch ? String(branch.name) : '',
      convertedInvoice: sale ? String(sale.invoice_no) : null,
    };
  }, [quoteId]);

  if (!data)
    return (
      <p className="p-4 text-text-muted">{t('office.quotations.not_found')}</p>
    );
  return <QuoteDetailBody quoteId={quoteId} data={data} />;
}

function QuoteDetailBody({ quoteId, data }: { quoteId: string; data: Loaded }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const setActive = useSellStore((s) => s.setActive);
  const { staff, can } = useCurrentStaff();
  const allStaff = useLiveQuery(() => getDb().staff.toArray(), []) ?? [];
  const readOnly = useReadOnly();
  const canQuote = can('sale.create');
  const recordBack = useRecordBack('/quotations', 'nav.sales');
  const openPeek = useOpenPeek();
  const wide = useMasterDetailWide();
  const desktop = useIsDesktop();
  const timeZone = useShopTimeZone();
  const { today } = useBusinessDates(timeZone);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [expiredOpen, setExpiredOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const { quote, lines } = data;
  const display = quoteStatus(quote, today);
  const terminal = display === 'converted' || display === 'cancelled';
  const expired = display === 'expired';

  const openCart = async (
    mode: 'edit' | 'convert' | 'duplicate',
    pricing: 'quoted' | 'today' = 'quoted',
    approvedBy: string | null = null,
  ) => {
    if (readOnly) {
      toast.push(t('tenant.readOnly.blocked'), 'error');
      return;
    }
    try {
      setBusy(true);
      const db = getDb();
      const carts = await db.carts.bulkGet(['c1', 'c2', 'c3']);
      const free = (['c1', 'c2', 'c3'] as const).find((_id, index) => {
        const cart = carts[index];
        return (
          !cart ||
          (cart.lines.length === 0 &&
            !cart.customer_id &&
            !cart.quote &&
            !cart.reissue &&
            !cart.backdate)
        );
      });
      if (!free) {
        toast.push(t('office.quotations.no_free_cart'), 'error');
        return;
      }
      const cart = await startQuoteCart(db, {
        quoteId,
        cartId: free,
        mode,
        pricing,
        approvedBy,
        staffId: staff?.id ?? null,
      });
      setActive(cart.id);
      void navigate({ to: '/sell' });
    } catch {
      toast.push(t('errors.generic'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    if (reason.trim().length === 0) return;
    try {
      setBusy(true);
      await cancelQuote(getDb(), {
        quoteId,
        reason,
        staffId: staff?.id ?? String(quote.staff_id),
      });
      setCancelOpen(false);
      toast.push(t('office.quotations.cancelled_toast'));
    } catch {
      toast.push(t('errors.generic'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doPrint = async () => {
    try {
      await queueQuotePrint(getDb(), quoteId);
      toast.push(t('office.quotations.print_queued'));
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };

  const doShare = async () => {
    const shareWindow = openShareWindow();
    try {
      const { quotationReceipt, receiptPng, downloadBlob } = await import(
        '../print/receiptFiles.ts'
      );
      const receipt = await quotationReceipt(getDb(), quoteId);
      if (!receipt) {
        closeShareWindow(shareWindow);
        return;
      }
      const png = await receiptPng(receipt);
      const text = quoteShareText(quote, lines, data.shopName);
      const phone = quote.customer_phone ? String(quote.customer_phone) : null;
      const link = phone ? waLink(phone, text) : null;
      const file = new File([png], `${String(quote.quote_no)}.png`, {
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
            title: String(quote.quote_no),
          });
        } else {
          downloadBlob(png, file.name);
          toast.push(t('done.image_saved'));
        }
      }
    } catch {
      closeShareWindow(shareWindow);
      toast.push(t('office.quotations.share_failed'), 'error');
    }
  };

  const doPdf = async () => {
    try {
      const { quotationReceipt, receiptPdf, downloadBlob } = await import(
        '../print/receiptFiles.ts'
      );
      const receipt = await quotationReceipt(getDb(), quoteId);
      if (!receipt) return;
      downloadBlob(await receiptPdf(receipt), `${String(quote.quote_no)}.pdf`);
    } catch {
      toast.push(t('office.quotations.pdf_failed'), 'error');
    }
  };

  const doDuplicate = async () => {
    if (readOnly) {
      toast.push(t('tenant.readOnly.blocked'), 'error');
      return;
    }
    try {
      setBusy(true);
      const db = getDb();
      const carts = await db.carts.bulkGet(['c1', 'c2', 'c3']);
      const free = (['c1', 'c2', 'c3'] as const).find((_id, index) => {
        const cart = carts[index];
        return (
          !cart ||
          (cart.lines.length === 0 &&
            !cart.customer_id &&
            !cart.quote &&
            !cart.reissue &&
            !cart.backdate)
        );
      });
      if (!free) {
        toast.push(t('office.quotations.no_free_cart'), 'error');
        return;
      }
      const cart = await startQuoteCart(db, {
        quoteId,
        cartId: free,
        mode: 'duplicate',
        staffId: staff?.id ?? null,
      });
      setActive(cart.id);
      void navigate({ to: '/sell' });
    } catch {
      toast.push(t('errors.generic'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const approve = can('catalog.edit');
  const approvers = saleApprovers(allStaff, {
    permission: 'catalog.edit',
    sellerId: staff?.id ?? null,
  });
  const verifyQuotePrice = async (pin: string, profileId: string) => {
    const approver = allStaff.find((row) => row.id === profileId);
    if (!approver) return false;
    const { verifyPinWithLockout } = await import('../data/pinLock.ts');
    const result = await verifyPinWithLockout(getDb(), approver.id, pin);
    if (result.kind !== 'ok') return false;
    setOverrideOpen(false);
    setTimeout(() => {
      void openCart('convert', 'quoted', approver.id);
    }, 0);
    return true;
  };

  const ready = !cancelOpen && !expiredOpen && !overrideOpen && !busy;
  useHotkey(plainKey('p'), () => void doPrint(), { enabled: ready });
  useHotkey(
    plainKey('c'),
    () => {
      if (expired) setExpiredOpen(true);
      else void openCart('convert');
    },
    { enabled: ready && !terminal && !readOnly && canQuote },
  );
  useHotkey(plainKey('e'), () => void openCart('edit'), {
    enabled: ready && !terminal && !readOnly && canQuote,
  });

  const groupNames = new Map<string, SyncedRow[]>();
  for (const line of lines) {
    if (!line.bundle_group) continue;
    const group = String(line.bundle_group);
    groupNames.set(group, [...(groupNames.get(group) ?? []), line]);
  }
  const seenGroups = new Set<string>();
  const canConvert = !terminal && !readOnly && canQuote;
  const moreActions: PageActionItem[] = [];
  if (!desktop && canConvert)
    moreActions.push({
      label: t('office.quotations.print'),
      onSelect: () => void doPrint(),
    });
  if (!desktop)
    moreActions.push({
      label: t('office.quotations.pdf'),
      onSelect: () => void doPdf(),
    });
  if (canConvert)
    moreActions.push({
      label: t('common.edit'),
      disabled: busy,
      onSelect: () => void openCart('edit'),
    });
  if (canQuote)
    moreActions.push({
      label: t('office.quotations.duplicate'),
      disabled: busy,
      onSelect: () => void doDuplicate(),
    });
  if (canConvert)
    moreActions.push({
      label: t('office.quotations.cancel'),
      tone: 'danger',
      disabled: busy,
      onSelect: () => setCancelOpen(true),
    });

  return (
    <div data-testid="quote-detail" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {recordBack ? (
          <Link
            to="/quotations"
            search={{ quote: undefined }}
            data-testid="quote-back"
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
          {String(quote.quote_no)}
        </h1>
        <span
          data-testid="quote-status"
          className={`rounded-full px-2 text-small font-medium ${
            display === 'open'
              ? 'bg-primary-subtle text-primary-subtle-ink'
              : display === 'converted'
                ? 'bg-success-subtle text-success-subtle-ink'
                : display === 'expired'
                  ? 'bg-warning-subtle text-warning-subtle-ink'
                  : 'bg-danger-subtle text-danger-subtle-ink'
          }`}
        >
          {t(`office.quotations.status_${display}`)}
        </span>
      </div>
      <PageActions
        primary={
          canConvert ? (
            <button
              type="button"
              data-testid="convert-quote"
              className={wide ? buttonQuiet : buttonPrimary}
              disabled={busy}
              onClick={() =>
                expired ? setExpiredOpen(true) : void openCart('convert')
              }
            >
              {t('office.quotations.convert')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="print-quote"
              className={wide ? buttonQuiet : buttonPrimary}
              onClick={() => void doPrint()}
            >
              {t('office.quotations.print')}
            </button>
          )
        }
        secondary={
          <>
            {desktop && canConvert ? (
              <button
                type="button"
                data-testid="print-quote"
                className={buttonQuiet}
                onClick={() => void doPrint()}
              >
                {t('office.quotations.print')}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="share-quote"
              className={buttonQuiet}
              onClick={() => void doShare()}
            >
              {t('office.quotations.share')}
            </button>
            {desktop ? (
              <button
                type="button"
                data-testid="pdf-quote"
                className={buttonQuiet}
                onClick={() => void doPdf()}
              >
                {t('office.quotations.pdf')}
              </button>
            ) : null}
          </>
        }
        more={moreActions}
        primaryLast={!wide}
      />

      {quote.converted_sale_id ? (
        <div
          data-testid="quote-converted-banner"
          className="rounded-control bg-success-subtle px-3 py-2 text-small text-success-subtle-ink"
        >
          {t('office.quotations.converted_to')}{' '}
          <Link
            to="/sales/$id"
            params={{ id: String(quote.converted_sale_id) }}
            className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
            onClick={(event) =>
              openPeek(
                event,
                { kind: 'bill', id: String(quote.converted_sale_id) },
                {
                  key: 'peek.origin_quotation',
                  params: { quote: String(quote.quote_no) },
                },
              )
            }
          >
            {data.convertedInvoice ?? ''}
            <ChevronRightIcon
              aria-hidden="true"
              className="size-4 rtl:rotate-180"
            />
          </Link>
        </div>
      ) : null}
      {expired ? (
        <div className="rounded-control bg-warning-subtle px-3 py-2 text-small text-warning-subtle-ink">
          {t('office.quotations.expired_notice', {
            date: formatBusinessDate(String(quote.valid_until), i18n.language),
          })}
        </div>
      ) : null}
      {display === 'cancelled' ? (
        <div className="rounded-control bg-danger-subtle px-3 py-2 text-small text-danger-subtle-ink">
          {t('office.quotations.cancelled_reason', {
            reason: String(quote.cancelled_reason ?? ''),
          })}
        </div>
      ) : null}

      <dl
        className={`grid grid-cols-2 gap-2 rounded-card border border-border bg-surface p-3 text-small ${
          wide ? '' : 'sm:grid-cols-4'
        }`}
      >
        <Meta
          label={t('office.quotations.created')}
          value={formatBusinessDate(String(quote.business_date), i18n.language)}
        />
        <Meta
          label={t('office.quotations.valid_until')}
          value={formatBusinessDate(String(quote.valid_until), i18n.language)}
        />
        <Meta
          label={t('office.quotations.customer')}
          value={
            quote.customer_name
              ? String(quote.customer_name)
              : t('sell.walk_in')
          }
        />
        <Meta
          label={t('office.quotations.staff')}
          value={data.staffName || '—'}
        />
        <Meta
          label={t('office.quotations.device')}
          value={data.deviceName || '—'}
        />
        <Meta
          label={t('office.quotations.branch')}
          value={data.branchName || '—'}
        />
      </dl>

      <section className="rounded-card border border-border bg-surface">
        <table className="w-full text-small">
          <thead>
            <tr className="border-b border-border text-start text-text-muted">
              <th className="p-2 text-start">{t('office.quotations.item')}</th>
              <th className="p-2 text-start">{t('office.quotations.qty')}</th>
              <th
                className={
                  wide ? 'hidden' : 'hidden p-2 text-start sm:table-cell'
                }
              >
                {t('office.quotations.unit_price')}
              </th>
              <th
                className={
                  wide ? 'hidden' : 'hidden p-2 text-start sm:table-cell'
                }
              >
                {t('office.quotations.discount')}
              </th>
              <th className="p-2 text-start">
                {t('office.quotations.amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              if (line.bundle_group) {
                const group = String(line.bundle_group);
                if (seenGroups.has(group)) return null;
                seenGroups.add(group);
                const groupLines = groupNames.get(group) ?? [line];
                const first = groupLines[0] ?? line;
                return (
                  <Fragment key={group}>
                    <tr className="border-b border-border bg-surface-2">
                      <td colSpan={5} className="p-2">
                        <span className="flex flex-wrap items-center gap-2 font-medium">
                          <span>
                            {String(first.bundle_name ?? first.name_snapshot)}
                          </span>
                          <span className="rounded-full bg-surface px-1.5 text-caption font-medium text-text-muted">
                            {t('office.quotations.bundle')}
                          </span>
                          <span className="ms-auto text-small text-text-muted">
                            {Number(first.bundle_qty ?? 0)} ×{' '}
                            <MoneyText
                              paisa={Number(first.bundle_price ?? 0)}
                            />
                          </span>
                        </span>
                      </td>
                    </tr>
                    {groupLines.map((component) => (
                      <tr
                        key={String(component.id)}
                        className="border-b border-border last:border-0"
                      >
                        <td className="p-2 ps-6">
                          {String(component.name_snapshot)}
                        </td>
                        <td className="p-2 tabular-nums">
                          {Number(component.qty_milli) / 1000}
                        </td>
                        <td
                          className={
                            wide
                              ? 'hidden'
                              : 'hidden p-2 text-start sm:table-cell'
                          }
                        >
                          <MoneyText paisa={Number(component.unit_price)} />
                        </td>
                        <td
                          className={
                            wide
                              ? 'hidden'
                              : 'hidden p-2 text-start sm:table-cell'
                          }
                        >
                          <MoneyText paisa={Number(component.discount ?? 0)} />
                        </td>
                        <td className="p-2 text-start">
                          <MoneyText paisa={Number(component.net ?? 0)} />
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                );
              }
              return (
                <tr
                  key={String(line.id)}
                  className="border-b border-border last:border-0"
                >
                  <td className="p-2">
                    {String(line.name_snapshot)}
                    {line.note ? (
                      <span className="block text-small text-text-muted">
                        {String(line.note)}
                      </span>
                    ) : null}
                  </td>
                  <td className="p-2 tabular-nums">
                    {Number(line.qty_milli) / 1000}
                  </td>
                  <td
                    className={
                      wide ? 'hidden' : 'hidden p-2 text-start sm:table-cell'
                    }
                  >
                    <MoneyText paisa={Number(line.unit_price)} />
                  </td>
                  <td
                    className={
                      wide ? 'hidden' : 'hidden p-2 text-start sm:table-cell'
                    }
                  >
                    <MoneyText paisa={Number(line.discount ?? 0)} />
                  </td>
                  <td className="p-2 text-start">
                    <MoneyText paisa={Number(line.net ?? 0)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="rounded-card border border-border bg-surface p-3 text-small">
          <h2 className="mb-2 text-title font-semibold">
            {t('office.quotations.total')}
          </h2>
          <Row
            label={t('office.quotations.subtotal')}
            value={<MoneyText paisa={Number(quote.subtotal ?? 0)} />}
          />
          {Number(quote.item_discount_total ?? 0) > 0 ? (
            <Row
              label={t('office.quotations.item_discounts')}
              value={<MoneyText paisa={Number(quote.item_discount_total)} />}
            />
          ) : null}
          {Number(quote.bill_discount ?? 0) > 0 ? (
            <Row
              label={t('office.quotations.discount')}
              value={<MoneyText paisa={Number(quote.bill_discount)} />}
            />
          ) : null}
          {Number(quote.tax ?? 0) > 0 && Number(quote.tax_inclusive) !== 1 ? (
            <Row
              label={t('office.quotations.tax', {
                rate: Number(quote.tax_rate_bp) / 100,
              })}
              value={<MoneyText paisa={Number(quote.tax)} />}
            />
          ) : null}
          {Number(quote.rounding ?? 0) !== 0 ? (
            <Row
              label={t('office.quotations.rounding')}
              value={<MoneyText paisa={Number(quote.rounding)} />}
            />
          ) : null}
          <Row
            label={t('office.quotations.total')}
            value={
              <span data-testid="quote-total">
                <MoneyText paisa={Number(quote.total ?? 0)} />
              </span>
            }
            strong
          />
          {Number(quote.tax ?? 0) > 0 && Number(quote.tax_inclusive) === 1 ? (
            <Row
              label={t('office.quotations.includes_tax', {
                rate: Number(quote.tax_rate_bp) / 100,
              })}
              value={<MoneyText paisa={Number(quote.tax)} />}
            />
          ) : null}
        </section>

        <section className="rounded-card border border-border bg-surface p-3 text-small">
          <h2 className="mb-2 text-title font-semibold">
            {t('office.quotations.terms')}
          </h2>
          {String(quote.note ?? '').trim() ? (
            <p
              dir="auto"
              className="whitespace-pre-wrap break-words rounded-control bg-surface-2 p-2"
            >
              {String(quote.note)}
            </p>
          ) : (
            <p className="text-text-muted">—</p>
          )}
          <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-border pt-2 text-caption text-text-muted">
            <span>
              {t('office.quotations.created_by', {
                staff: data.staffName || '—',
              })}
            </span>
            <span data-testid="quote-not-invoice">
              {t('office.quotations.not_tax_invoice')}
            </span>
          </div>
        </section>
      </div>

      <Modal
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('office.quotations.cancel_title')}
      >
        <p className="text-small text-text-muted">
          {t('office.quotations.cancel_body')}
        </p>
        <textarea
          className="min-h-24 w-full rounded-control border border-border-strong bg-surface px-3 py-2"
          value={reason}
          maxLength={120}
          placeholder={t('office.quotations.cancel_reason')}
          onChange={(event) => setReason(event.target.value)}
        />
        <DialogFooter>
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => setCancelOpen(false)}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={buttonDangerQuiet}
            disabled={busy || reason.trim().length === 0}
            onClick={() => void doCancel()}
          >
            {t('office.quotations.cancel')}
          </button>
        </DialogFooter>
      </Modal>

      <Modal
        open={expiredOpen}
        onOpenChange={setExpiredOpen}
        title={t('office.quotations.expired_title')}
      >
        <p className="text-small text-text-muted">
          {t('office.quotations.expired_choice_body', {
            date: formatBusinessDate(String(quote.valid_until), i18n.language),
          })}
        </p>
        <DialogFooter>
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => setExpiredOpen(false)}
          >
            {t('common.cancel')}
          </button>
          {approve || approvers.length > 0 ? (
            <button
              type="button"
              data-testid="use-quoted"
              className={buttonQuiet}
              disabled={busy}
              onClick={() => {
                setExpiredOpen(false);
                if (approve)
                  void openCart('convert', 'quoted', staff?.id ?? null);
                else setOverrideOpen(true);
              }}
            >
              {t('office.quotations.use_quoted')}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="convert-today"
            className={buttonPrimary}
            disabled={busy}
            onClick={() => {
              setExpiredOpen(false);
              void openCart('convert', 'today');
            }}
          >
            {t('office.quotations.convert_today')}
          </button>
        </DialogFooter>
      </Modal>

      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        body={t('office.quotations.quoted_approval_body')}
        profiles={approvers.map((row) => ({
          id: row.id,
          label: String(row.name),
        }))}
        verify={verifyQuotePrice}
      />
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-text-muted">{label}</dt>
      <dd className="truncate">{value}</dd>
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
