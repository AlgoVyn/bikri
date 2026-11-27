import * as Dialog from '@radix-ui/react-dialog';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary } from '../components/classes.ts';
import {
  ChevronLeftIcon,
  CloseIcon,
  ProductsIcon,
  QuoteIcon,
  SalesIcon,
  SuppliersIcon,
  UserIcon,
} from '../components/icons.tsx';
import { getDb } from '../data/db.ts';
import { useAreaStrings } from '../i18n/areas.tsx';
import { categoryName } from '../lib/category.ts';
import { formatBusinessDate, formatTimestamp } from '../lib/date.ts';
import { isLatinName } from '../lib/productFormat.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { billVisible, quoteVisible } from '../state/reportScope.ts';
import {
  type BillPeekData,
  type CustomerPeekData,
  type DeliveryPeekData,
  loadBillPeek,
  loadCustomerPeek,
  loadDeliveryPeek,
  loadProductPeek,
  loadQuotationPeek,
  type ProductPeekData,
  type QuotationPeekData,
} from './data.ts';
import {
  BillPeekBody,
  CustomerPeekBody,
  DeliveryPeekBody,
  ProductPeekBody,
  QuotationPeekBody,
} from './PeekBodies.tsx';
import { PeekNote } from './PeekLayout.tsx';
import {
  type PeekKind,
  type PeekTarget,
  parseOrigin,
  parsePeekTarget,
} from './peek.ts';
import { useClosePeek } from './usePeekNavigation.ts';

type PeekResult =
  | { status: 'ok'; kind: 'product'; data: ProductPeekData }
  | { status: 'ok'; kind: 'bill'; data: BillPeekData }
  | { status: 'ok'; kind: 'quotation'; data: QuotationPeekData }
  | { status: 'ok'; kind: 'customer'; data: CustomerPeekData }
  | { status: 'ok'; kind: 'delivery'; data: DeliveryPeekData }
  | { status: 'missing' | 'denied'; kind: PeekKind };

function kindLabelKey(kind: PeekKind) {
  if (kind === 'product') return 'peek.product_reference';
  if (kind === 'bill') return 'peek.bill_reference';
  if (kind === 'quotation') return 'peek.quotation_reference';
  if (kind === 'customer') return 'peek.customer_reference';
  return 'peek.delivery_reference';
}

function KindIcon({ kind }: { kind: PeekKind }) {
  if (kind === 'product') return <ProductsIcon />;
  if (kind === 'bill') return <SalesIcon />;
  if (kind === 'quotation') return <QuoteIcon />;
  if (kind === 'customer') return <UserIcon />;
  return <SuppliersIcon />;
}

function openFullLabel(kind: PeekKind) {
  if (kind === 'product') return 'peek.open_product';
  if (kind === 'bill') return 'peek.open_bill';
  if (kind === 'quotation') return 'peek.open_quotation';
  if (kind === 'customer') return 'peek.open_khata';
  return 'peek.open_delivery';
}

/** Only mount the content (and lazily load office strings) when a peek is requested. */
export function PeekHost() {
  const search = useSearch({ strict: false }) as { peek?: unknown };
  const target = parsePeekTarget(search.peek);
  if (target === null) return null;
  return <PeekContent target={target} />;
}

/**
 * The shared reference peek. Desktop is a 560 px end-side panel over a scrim; below
 * 1280 it is a 92 dVH bottom sheet. One read-only summary, one `Open full` action.
 */
function PeekContent({ target }: { target: PeekTarget }) {
  const { t, i18n } = useTranslation();
  const officeStringsReady = useAreaStrings('office');
  const navigate = useNavigate();
  const location = useLocation();
  const origin = parseOrigin(
    (location.state as unknown as Record<string, unknown> | undefined)
      ?.bikriPeek,
  );
  const close = useClosePeek();
  const { can, role, support, branchId } = useCurrentStaff();
  const canQuote = can('sale.create');
  const canReport = can('report.view');
  const canCost = can('cost.view');
  const canCustomer = can('payment.receive');
  const canDelivery = can('purchase.create') || canCost;

  const result = useLiveQuery(async (): Promise<PeekResult | null> => {
    if (target === null) return null;
    const db = getDb();
    if (target.kind === 'product') {
      const data = await loadProductPeek(db, target.id);
      return data
        ? { status: 'ok', kind: 'product', data }
        : { status: 'missing', kind: 'product' };
    }
    if (target.kind === 'bill') {
      const data = await loadBillPeek(db, target.id);
      if (data === null) return { status: 'missing', kind: 'bill' };
      const sameDay = String(data.detail.sale.business_date) === data.today;
      const sameBranch =
        branchId === null || String(data.detail.sale.branch_id) === branchId;
      if (!billVisible(role, support, canReport, sameDay, sameBranch)) {
        return { status: 'denied', kind: 'bill' };
      }
      return { status: 'ok', kind: 'bill', data };
    }
    if (target.kind === 'quotation') {
      if (!canQuote) return { status: 'denied', kind: 'quotation' };
      const data = await loadQuotationPeek(db, target.id);
      if (!data) return { status: 'missing', kind: 'quotation' };
      const visible = quoteVisible({
        role,
        support,
        canViewReports: canReport,
        canQuote,
        status: String(data.quote.status),
        businessDate: String(data.quote.business_date),
        branchId,
        quoteBranchId: String(data.quote.branch_id ?? ''),
        today: data.today,
        timeZone: data.timeZone,
        convertedAt: Number(data.quote.converted_at ?? 0) || null,
        cancelledAt: Number(data.quote.cancelled_at ?? 0) || null,
      });
      return visible
        ? { status: 'ok', kind: 'quotation', data }
        : { status: 'denied', kind: 'quotation' };
    }
    if (target.kind === 'customer') {
      if (!canCustomer) return { status: 'denied', kind: 'customer' };
      const data = await loadCustomerPeek(db, target.id);
      return data
        ? { status: 'ok', kind: 'customer', data }
        : { status: 'missing', kind: 'customer' };
    }
    if (!canDelivery) return { status: 'denied', kind: 'delivery' };
    const data = await loadDeliveryPeek(db, target.id);
    return data
      ? { status: 'ok', kind: 'delivery', data }
      : { status: 'missing', kind: 'delivery' };
  }, [
    target?.kind,
    target?.id,
    role,
    support,
    branchId,
    canReport,
    canCost,
    canCustomer,
    canDelivery,
    canQuote,
  ]);

  if (target === null) return null;

  const originLabel =
    origin === null ? null : t(origin.labelKey, origin.labelParams);
  const kindLabel = t(kindLabelKey(target.kind));
  const backLabel =
    originLabel === null
      ? t('common.back')
      : t('peek.back_to', { name: originLabel });

  const openFull = (
    event: React.MouseEvent<HTMLButtonElement>,
    data: PeekResult & { status: 'ok' },
  ) => {
    event.preventDefault();
    if (origin !== null) {
      if (data.kind === 'product') {
        void navigate({
          to: '/products/$id',
          params: { id: target.id },
          search: {},
          replace: true,
          state: (previous) => ({ ...previous, bikriReturn: origin }),
        });
      } else if (data.kind === 'bill') {
        void navigate({
          to: '/sales/$id',
          params: { id: target.id },
          search: {},
          replace: true,
          state: (previous) => ({ ...previous, bikriReturn: origin }),
        });
      } else if (data.kind === 'quotation') {
        void navigate({
          to: '/quotations/$id',
          params: { id: target.id },
          search: {},
          replace: true,
          state: (previous) => ({ ...previous, bikriReturn: origin }),
        });
      } else if (data.kind === 'customer') {
        void navigate({
          to: '/udhaar/$customerId',
          params: { customerId: target.id },
          search: {},
          replace: true,
          state: (previous) => ({ ...previous, bikriReturn: origin }),
        });
      } else {
        void navigate({
          to: '/suppliers/$supplierId',
          params: {
            supplierId: String(data.data.detail.purchase.supplier_id),
          },
          search: { delivery: target.id },
          replace: true,
          state: (previous) => ({ ...previous, bikriReturn: origin }),
        });
      }
      return;
    }
    if (data.kind === 'product') {
      void navigate({
        to: '/products/$id',
        params: { id: target.id },
        search: {},
        replace: true,
      });
    } else if (data.kind === 'bill') {
      void navigate({
        to: '/sales/$id',
        params: { id: target.id },
        search: {},
        replace: true,
      });
    } else if (data.kind === 'quotation') {
      void navigate({
        to: '/quotations/$id',
        params: { id: target.id },
        search: {},
        replace: true,
      });
    } else if (data.kind === 'customer') {
      void navigate({
        to: '/udhaar/$customerId',
        params: { customerId: target.id },
        search: {},
        replace: true,
      });
    } else {
      void navigate({
        to: '/suppliers/$supplierId',
        params: { supplierId: String(data.data.detail.purchase.supplier_id) },
        search: { delivery: target.id },
        replace: true,
      });
    }
  };

  const shell = (
    title: ReactNode,
    titleClass: string,
    subtitle: ReactNode,
    body: ReactNode,
    footer?: ReactNode,
  ) => (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="bikri-overlay fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="bikri-dialog bikri-peek fixed z-50 flex flex-col overflow-hidden bg-surface text-text shadow-modal"
        >
          <div className="hidden items-start justify-between gap-3 px-4 pt-3 xl:flex">
            <div className="min-w-0">
              <span className="flex items-center gap-1.5 text-small font-semibold text-text-muted">
                <span className="[&_svg]:size-4">
                  <KindIcon kind={target.kind} />
                </span>
                {kindLabel}
              </span>
              {originLabel === null ? null : (
                <p className="mt-0.5 text-small text-text-muted">
                  {t('peek.from', { name: originLabel })}
                </p>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t('common.close')}
                className="flex size-11 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface text-text hover:bg-surface-2"
              >
                <CloseIcon className="size-5" />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex items-center justify-between gap-2 px-4 pt-2 xl:hidden">
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={backLabel}
                className="flex min-h-11 items-center gap-1 text-body font-semibold text-text"
              >
                <ChevronLeftIcon className="size-5 rtl:rotate-180" />
                {t('common.back')}
              </button>
            </Dialog.Close>
            <span className="flex min-w-0 items-center gap-1.5 text-small font-semibold text-text-muted">
              <span className="[&_svg]:size-4">
                <KindIcon kind={target.kind} />
              </span>
              <span className="truncate">{kindLabel}</span>
            </span>
          </div>
          {originLabel === null ? null : (
            <p className="px-4 text-small text-text-muted xl:hidden">
              {t('peek.from', { name: originLabel })}
            </p>
          )}

          <div className="px-4 pb-3 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <Dialog.Title
                className={`min-w-0 text-h1 font-semibold ${titleClass}`}
              >
                {title}
              </Dialog.Title>
            </div>
            {subtitle ? (
              <div className="mt-0.5 text-small text-text-muted">
                {subtitle}
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
            <div className="flex flex-col gap-3">{body}</div>
          </div>

          {footer ? (
            <div className="bikri-peek-footer flex shrink-0 justify-end border-t border-border p-3">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );

  if (!officeStringsReady) {
    return shell(
      t('common.loading'),
      '',
      null,
      <>
        <div className="h-20 animate-pulse rounded-card bg-surface-2" />
        <div className="h-32 animate-pulse rounded-card bg-surface-2" />
        <div className="h-28 animate-pulse rounded-card bg-surface-2" />
      </>,
    );
  }

  if (result === undefined) {
    return shell(
      t('common.loading'),
      '',
      null,
      <>
        <div className="h-20 animate-pulse rounded-card bg-surface-2" />
        <div className="h-32 animate-pulse rounded-card bg-surface-2" />
        <div className="h-28 animate-pulse rounded-card bg-surface-2" />
      </>,
    );
  }

  if (result === null) return null;

  if (result.status !== 'ok') {
    return shell(
      kindLabel,
      '',
      null,
      <PeekNote>
        {result.status === 'missing'
          ? t('peek.not_found')
          : t('peek.no_access')}
      </PeekNote>,
    );
  }

  if (result.kind === 'product') {
    const { product, category } = result.data;
    const name = String(product.name_en || product.name_ur || product.sku);
    const urdu = String(product.name_ur ?? '').trim();
    const sku = String(product.sku ?? '');
    const categoryLabel = categoryName(category, i18n.language);
    return shell(
      <span className={`data-name ${isLatinName(name) ? 'ltr-name' : ''}`}>
        {name}
      </span>,
      '',
      <>
        {urdu ? (
          <span className="block font-urdu" lang="ur" dir="rtl">
            <bdi>{urdu}</bdi>
          </span>
        ) : null}
        <span className="block">
          {categoryLabel}
          {categoryLabel && sku ? ' · ' : null}
          {sku ? (
            <>
              {t('products.sku')}{' '}
              <bdi dir="ltr" className="font-mono">
                {sku}
              </bdi>
            </>
          ) : null}
        </span>
      </>,
      <ProductPeekBody
        data={result.data}
        showCost={canCost}
        showDelivery={canDelivery}
        showLastSale={
          result.data.lastSale !== null &&
          billVisible(
            role,
            support,
            canReport,
            result.data.lastSale.date === result.data.today,
            branchId === null || result.data.lastSale.branchId === branchId,
          )
        }
      />,
      <button
        type="button"
        className={`${buttonPrimary} w-full xl:w-auto`}
        onClick={(event) => openFull(event, result)}
      >
        {t(openFullLabel(target.kind))}
      </button>,
    );
  }

  if (result.kind === 'bill') {
    const { detail } = result.data;
    return shell(
      <bdi dir="ltr" className="font-mono">
        {String(detail.sale.invoice_no)}
      </bdi>,
      '',
      null,
      <BillPeekBody data={result.data} />,
      <button
        type="button"
        className={`${buttonPrimary} w-full xl:w-auto`}
        onClick={(event) => openFull(event, result)}
      >
        {t(openFullLabel(target.kind))}
      </button>,
    );
  }

  if (result.kind === 'quotation') {
    const { quote, timeZone } = result.data;
    return shell(
      <bdi dir="ltr" className="font-mono">
        {String(quote.quote_no)}
      </bdi>,
      '',
      <span className="flex flex-col gap-0.5">
        <span className="block">
          {quote.customer_name
            ? String(quote.customer_name)
            : t('office.sales.walk_in')}
        </span>
        <span className="block text-caption">
          {t('office.quotations.valid_until')}{' '}
          {formatBusinessDate(
            String(quote.valid_until),
            i18n.language,
            timeZone,
          )}
        </span>
      </span>,
      <QuotationPeekBody data={result.data} />,
      <button
        type="button"
        className={`${buttonPrimary} w-full xl:w-auto`}
        onClick={(event) => openFull(event, result)}
      >
        {t(openFullLabel(target.kind))}
      </button>,
    );
  }

  if (result.kind === 'customer') {
    const { customer, timeZone } = result.data;
    const name = String(customer.name);
    const phone = String(customer.phone ?? '').trim();
    const address = String(customer.address ?? '').trim();
    return shell(
      <span className={`data-name ${isLatinName(name) ? 'ltr-name' : ''}`}>
        {name}
      </span>,
      '',
      <span className="flex flex-col gap-0.5">
        {phone ? (
          <span dir="ltr" className="block">
            {phone}
          </span>
        ) : null}
        {address ? <span className="block break-words">{address}</span> : null}
        <span className="block text-caption">
          {t('peek.customer_since', {
            date: formatTimestamp(
              Number(customer.created_at),
              i18n.language,
              timeZone,
              'date',
            ),
          })}
        </span>
      </span>,
      <CustomerPeekBody data={result.data} />,
      <button
        type="button"
        className={`${buttonPrimary} w-full xl:w-auto`}
        onClick={(event) => openFull(event, result)}
      >
        {t(openFullLabel(target.kind))}
      </button>,
    );
  }

  const { invoiceNo, timeZone } = result.data;
  const { purchase, supplier } = result.data.detail;
  const supplierPhone = String(supplier.phone ?? '').trim();
  const supplierAddress = String(supplier.address ?? '').trim();
  return shell(
    <bdi dir="ltr" className="font-mono">
      {invoiceNo}
    </bdi>,
    '',
    <span className="flex flex-col gap-0.5">
      <span className="block">{String(supplier.name)}</span>
      {supplierPhone ? (
        <span dir="ltr" className="block">
          {supplierPhone}
        </span>
      ) : null}
      {supplierAddress ? (
        <span className="block break-words">{supplierAddress}</span>
      ) : null}
      <span className="block text-caption">
        {formatTimestamp(
          Number(purchase.created_at),
          i18n.language,
          timeZone,
          'date',
        )}
      </span>
    </span>,
    <DeliveryPeekBody data={result.data} />,
    <button
      type="button"
      className={`${buttonPrimary} w-full xl:w-auto`}
      onClick={(event) => openFull(event, result)}
    >
      {t(openFullLabel(target.kind))}
    </button>,
  );
}
