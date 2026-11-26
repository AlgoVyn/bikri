import { formatQtyFromMilli } from '@bikri/core';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyText } from '../components/MoneyText.tsx';
import { quoteStatus } from '../data/quotes.ts';
import { formatBusinessDate, formatTimestamp } from '../lib/date.ts';
import { isLatinName, qtyWithUnit } from '../products/format.ts';
import { statusLabel, statusTone } from '../sales/format.ts';
import { ageLabel, entryDescription } from '../udhaar/format.ts';
import {
  type BillPeekData,
  billLineTotal,
  billPaidTotal,
  type CustomerPeekData,
  type DeliveryPeekData,
  type ProductPeekData,
  type QuotationPeekData,
} from './data.ts';
import {
  PeekEmpty,
  PeekFacts,
  PeekFigure,
  PeekNote,
  PeekRow,
  PeekSection,
} from './PeekLayout.tsx';

const dash = '—';

export function ProductPeekBody({
  data,
  showCost,
  showDelivery,
  showLastSale,
}: {
  data: ProductPeekData;
  showCost: boolean;
  showDelivery: boolean;
  showLastSale: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { product, unit, timeZone } = data;
  const available =
    data.onHand === null
      ? t('peek.not_tracked')
      : qtyWithUnit(t, data.onHand, unit);
  const thirdLabel = showCost ? t('peek.margin') : t('peek.min_stock');
  const thirdValue = showCost
    ? (data.margin ?? dash)
    : data.minStock > 0
      ? qtyWithUnit(t, data.minStock, unit)
      : dash;
  const rows = [
    {
      label: t('peek.last_sold'),
      value:
        showLastSale && data.lastSale ? (
          <span>
            {formatBusinessDate(data.lastSale.date, i18n.language, timeZone)}
            {' · '}
            <bdi dir="ltr">{data.lastSale.invoice}</bdi>
          </span>
        ) : (
          dash
        ),
    },
  ];
  if (showDelivery)
    rows.push(
      {
        label: t('peek.last_delivery'),
        value: data.lastDelivery ? (
          <span>
            {formatBusinessDate(
              data.lastDelivery.date,
              i18n.language,
              timeZone,
            )}
            {' · '}
            <bdi dir="ltr">{data.lastDelivery.invoice}</bdi>
          </span>
        ) : (
          dash
        ),
      },
      {
        label: t('peek.supplier'),
        value: data.lastDelivery?.supplier ?? dash,
      },
    );

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <PeekFigure label={t('peek.price')}>
          <MoneyText paisa={data.price} />
        </PeekFigure>
        <PeekFigure label={t('peek.available')}>{available}</PeekFigure>
        <PeekFigure label={thirdLabel}>{thirdValue}</PeekFigure>
      </div>
      <PeekFacts rows={rows} />
      <PeekSection title={t('peek.stock_history')}>
        {data.history.length === 0 ? (
          <PeekEmpty>{t('products.history_empty')}</PeekEmpty>
        ) : (
          data.history.map((row) => (
            <PeekRow
              key={row.id}
              label={
                <>
                  <span className="block font-medium">
                    {t(`stock.reason.${row.reasonCode}`)}
                  </span>
                  <span className="block text-caption text-text-muted">
                    {formatBusinessDate(row.date, i18n.language, timeZone)}
                  </span>
                </>
              }
              value={
                <>
                  <span className="block">
                    {qtyWithUnit(t, row.qtyMilli, unit)}
                  </span>
                  <span className="block text-caption text-text-muted">
                    {t('peek.balance_after', {
                      qty: qtyWithUnit(t, row.balanceAfter, unit),
                    })}
                  </span>
                </>
              }
            />
          ))
        )}
      </PeekSection>
      <PeekNote>{t('peek.reference_only')}</PeekNote>
      <span className="sr-only">{String(product.name_en)}</span>
    </>
  );
}

export function BillPeekBody({ data }: { data: BillPeekData }) {
  const { t, i18n } = useTranslation();
  const { detail, timeZone } = data;
  const status = String(detail.sale.status);
  const paid = billPaidTotal(detail);
  const paidPayments = detail.payments.filter(
    (payment) => String(payment.direction) === 'in',
  );
  const methods = new Set(
    paidPayments.map((payment) => String(payment.method)),
  );
  const method =
    methods.size === 1 ? t(`payment.${[...methods][0]}`) : t('peek.payment');

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 text-small font-medium ${statusTone(status)}`}
        >
          {statusLabel(t, status)}
        </span>
        <span className="text-small text-text-muted">
          {formatTimestamp(
            Number(detail.sale.created_at),
            i18n.language,
            timeZone,
          )}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <PeekFigure label={t('peek.total')}>
          <MoneyText paisa={Number(detail.sale.total)} />
        </PeekFigure>
        <PeekFigure label={t('peek.items')}>
          {Number(detail.sale.line_count)}
        </PeekFigure>
        <PeekFigure label={t('peek.refunded')}>
          <MoneyText paisa={detail.refundedTotal} />
        </PeekFigure>
      </div>
      <PeekFacts
        rows={[
          {
            label: t('peek.customer'),
            value: detail.customer
              ? String(detail.customer.name)
              : t('office.sales.walk_in'),
          },
          { label: t('peek.cashier'), value: detail.staffName },
          { label: t('peek.device'), value: detail.deviceName },
        ]}
      />
      <PeekSection title={t('peek.items_section')}>
        {detail.lines.length === 0 ? (
          <PeekEmpty>{t('peek.none')}</PeekEmpty>
        ) : (
          (() => {
            const blocks: {
              key: string;
              label: ReactNode;
              value: number;
            }[] = [];
            const seenGroups = new Set<string>();
            for (const line of detail.lines) {
              const group =
                line.line.bundle_group == null
                  ? null
                  : String(line.line.bundle_group);
              if (group === null) {
                blocks.push({
                  key: String(line.line.id),
                  label: (
                    <>
                      <span
                        className={`data-name ${
                          isLatinName(String(line.line.name_snapshot))
                            ? 'ltr-name'
                            : ''
                        }`}
                      >
                        {String(line.line.name_snapshot)}
                      </span>
                      <span className="block text-caption text-text-muted">
                        {qtyWithUnit(t, Number(line.line.qty_milli), line.unit)}
                      </span>
                    </>
                  ),
                  value: billLineTotal(detail, line.line),
                });
                continue;
              }
              if (seenGroups.has(group)) continue;
              seenGroups.add(group);
              const groupLines = detail.lines.filter(
                (row) =>
                  row.line.bundle_group != null &&
                  String(row.line.bundle_group) === group,
              );
              const first = groupLines[0]?.line;
              blocks.push({
                key: group,
                label: (
                  <>
                    <span className="block font-medium">
                      {String(first?.bundle_name ?? '')}
                    </span>
                    {groupLines.map((row) => (
                      <span
                        key={String(row.line.id)}
                        className="block text-caption text-text-muted"
                      >
                        {String(row.line.name_snapshot)} ·{' '}
                        {qtyWithUnit(t, Number(row.line.qty_milli), row.unit)}
                      </span>
                    ))}
                  </>
                ),
                value: groupLines.reduce(
                  (sum, row) => sum + billLineTotal(detail, row.line),
                  0,
                ),
              });
            }
            const shown = blocks.slice(0, 3);
            const remaining = blocks.length - shown.length;
            return (
              <>
                {shown.map((block) => (
                  <PeekRow
                    key={block.key}
                    label={block.label}
                    value={<MoneyText paisa={block.value} />}
                  />
                ))}
                {remaining > 0 ? (
                  <PeekRow
                    label={t('peek.and_more', { count: remaining })}
                    value=""
                  />
                ) : null}
              </>
            );
          })()
        )}
      </PeekSection>
      <PeekSection title={t('peek.payment')}>
        {paidPayments.length === 0 ? (
          <PeekEmpty>{t('office.bill.no_payments')}</PeekEmpty>
        ) : (
          <PeekRow label={method} value={<MoneyText paisa={paid} />} strong />
        )}
      </PeekSection>
      <PeekNote>{t('peek.reference_only')}</PeekNote>
    </>
  );
}

export function QuotationPeekBody({ data }: { data: QuotationPeekData }) {
  const { t, i18n } = useTranslation();
  const display = quoteStatus(data.quote, data.today);
  const tone =
    display === 'open'
      ? 'bg-primary-subtle text-primary-subtle-ink'
      : display === 'converted'
        ? 'bg-success-subtle text-success-subtle-ink'
        : display === 'expired'
          ? 'bg-warning-subtle text-warning-subtle-ink'
          : 'bg-danger-subtle text-danger-subtle-ink';
  const blocks: {
    key: string;
    label: ReactNode;
    value: number;
  }[] = [];
  const seenGroups = new Set<string>();
  for (const line of data.lines) {
    const group = line.bundle_group == null ? null : String(line.bundle_group);
    if (group === null) {
      blocks.push({
        key: String(line.id),
        label: (
          <>
            <span
              className={`data-name ${
                isLatinName(String(line.name_snapshot)) ? 'ltr-name' : ''
              }`}
            >
              {String(line.name_snapshot)}
            </span>
            <span className="block text-caption text-text-muted">
              {formatQtyFromMilli(Number(line.qty_milli), '')}
            </span>
          </>
        ),
        value: Number(line.net),
      });
      continue;
    }
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    const groupLines = data.lines.filter(
      (candidate) =>
        candidate.bundle_group != null &&
        String(candidate.bundle_group) === group,
    );
    const first = groupLines[0];
    blocks.push({
      key: group,
      label: (
        <>
          <span className="block font-medium">
            {String(first?.bundle_name ?? '')}
          </span>
          {groupLines.map((component) => (
            <span
              key={String(component.id)}
              className="block text-caption text-text-muted"
            >
              {String(component.name_snapshot)} ·{' '}
              {formatQtyFromMilli(Number(component.qty_milli), '')}
            </span>
          ))}
        </>
      ),
      value: groupLines.reduce(
        (sum, component) => sum + Number(component.net),
        0,
      ),
    });
  }
  const lines = blocks.slice(0, 3);
  const remaining = blocks.length - lines.length;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 text-small font-medium ${tone}`}>
          {t(`office.quotations.status_${display}`)}
        </span>
        <span className="text-small text-text-muted">
          {formatTimestamp(
            Number(data.quote.created_at),
            i18n.language,
            data.timeZone,
          )}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <PeekFigure label={t('peek.total')}>
          <MoneyText paisa={Number(data.quote.total)} />
        </PeekFigure>
        <PeekFigure label={t('peek.items')}>
          {formatQtyFromMilli(Number(data.quote.items_qty_milli), '')}
        </PeekFigure>
        <PeekFigure label={t('peek.lines')}>
          {Number(data.quote.line_count)}
        </PeekFigure>
      </div>
      <PeekFacts
        rows={[
          {
            label: t('peek.customer'),
            value: data.quote.customer_name
              ? String(data.quote.customer_name)
              : t('office.sales.walk_in'),
          },
          {
            label: t('office.quotations.valid_until'),
            value: formatBusinessDate(
              String(data.quote.valid_until),
              i18n.language,
              data.timeZone,
            ),
          },
          { label: t('peek.cashier'), value: data.staffName || dash },
          { label: t('peek.device'), value: data.deviceName || dash },
        ]}
      />
      <PeekSection title={t('peek.items_section')}>
        {data.lines.length === 0 ? (
          <PeekEmpty>{t('peek.none')}</PeekEmpty>
        ) : (
          <>
            {lines.map((line) => (
              <PeekRow
                key={line.key}
                label={line.label}
                value={<MoneyText paisa={line.value} />}
              />
            ))}
            {remaining > 0 ? (
              <PeekRow
                label={t('peek.and_more', { count: remaining })}
                value=""
              />
            ) : null}
          </>
        )}
      </PeekSection>
      <PeekNote>{t('peek.reference_only')}</PeekNote>
    </>
  );
}

export function CustomerPeekBody({ data }: { data: CustomerPeekData }) {
  const { t, i18n } = useTranslation();
  const { customer, statement, timeZone } = data;
  const recentRows = [...statement.rows].reverse();
  const lastSale = statement.rows.findLast((row) => row.kind === 'sale');
  const oldest = ageLabel(t, data.oldestUnpaidAt);

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <PeekFigure label={t('peek.balance')}>
          <MoneyText paisa={data.balance} />
        </PeekFigure>
        <PeekFigure label={t('peek.credit_limit')}>
          {data.creditLimit > 0 ? <MoneyText paisa={data.creditLimit} /> : dash}
        </PeekFigure>
        <PeekFigure label={t('peek.oldest_unpaid')}>
          {oldest || dash}
        </PeekFigure>
      </div>
      <PeekFacts
        rows={[
          {
            label: t('peek.next_promise'),
            value: data.promise ? (
              <span>
                {formatBusinessDate(
                  String(data.promise.promised_on),
                  i18n.language,
                  timeZone,
                )}
                {' · '}
                <MoneyText paisa={Number(data.promise.amount)} />
              </span>
            ) : (
              dash
            ),
          },
          {
            label: t('peek.last_payment'),
            value:
              statement.lastPaymentAt === null
                ? dash
                : formatTimestamp(
                    statement.lastPaymentAt,
                    i18n.language,
                    timeZone,
                    'date',
                  ),
          },
          {
            label: t('peek.last_bill'),
            value: lastSale?.invoiceNo ? (
              <bdi dir="ltr">{lastSale.invoiceNo}</bdi>
            ) : (
              dash
            ),
          },
        ]}
      />
      <PeekSection title={t('peek.recent_entries')}>
        {recentRows.length === 0 ? (
          <PeekEmpty>{t('office.udhaar.no_entries')}</PeekEmpty>
        ) : (
          recentRows.map((row) => (
            <PeekRow
              key={String(row.entry.id)}
              label={entryDescription(t, row)}
              value={
                <MoneyText paisa={row.debit > 0 ? row.debit : -row.credit} />
              }
            />
          ))
        )}
      </PeekSection>
      <PeekNote>{t('peek.reference_only')}</PeekNote>
      <span className="sr-only">{String(customer.name)}</span>
    </>
  );
}

export function DeliveryPeekBody({ data }: { data: DeliveryPeekData }) {
  const { t, i18n } = useTranslation();
  const { detail, invoiceNo, timeZone } = data;
  const { purchase } = detail;

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <PeekFigure label={t('peek.total')}>
          <MoneyText paisa={Number(purchase.total)} />
        </PeekFigure>
        <PeekFigure label={t('peek.lines')}>
          {Number(purchase.line_count)}
        </PeekFigure>
        <PeekFigure label={t('peek.paid_now')}>
          <MoneyText paisa={Number(purchase.paid_now)} />
        </PeekFigure>
      </div>
      <PeekFacts
        rows={[
          { label: t('peek.supplier'), value: String(detail.supplier.name) },
          {
            label: t('peek.date'),
            value: formatBusinessDate(
              String(purchase.business_date),
              i18n.language,
              timeZone,
            ),
          },
          {
            label: t('peek.linked_returns'),
            value:
              detail.returns.length === 0
                ? t('peek.none')
                : String(detail.returns.length),
          },
        ]}
      />
      <PeekSection title={t('peek.items_section')}>
        {detail.lines.length === 0 ? (
          <PeekEmpty>{t('office.suppliers.no_entries')}</PeekEmpty>
        ) : (
          detail.lines.slice(0, 3).map((line) => (
            <PeekRow
              key={String(line.line.id)}
              label={
                <>
                  <span
                    className={`data-name ${
                      isLatinName(line.name) ? 'ltr-name' : ''
                    }`}
                  >
                    {line.name}
                  </span>
                  <span className="block text-caption text-text-muted">
                    {qtyWithUnit(t, line.qtyMilli, line.unit)}
                  </span>
                </>
              }
              value={<MoneyText paisa={line.lineTotal} />}
            />
          ))
        )}
      </PeekSection>
      <PeekNote>{t('peek.reference_only')}</PeekNote>
      <span className="sr-only">
        <bdi dir="ltr">{invoiceNo}</bdi>
      </span>
    </>
  );
}
