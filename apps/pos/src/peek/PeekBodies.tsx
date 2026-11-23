import { useTranslation } from 'react-i18next';
import { MoneyText } from '../components/MoneyText.tsx';
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
}: {
  data: ProductPeekData;
  showCost: boolean;
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

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <PeekFigure label={t('peek.price')}>
          <MoneyText paisa={data.price} />
        </PeekFigure>
        <PeekFigure label={t('peek.available')}>{available}</PeekFigure>
        <PeekFigure label={thirdLabel}>{thirdValue}</PeekFigure>
      </div>
      <PeekFacts
        rows={[
          {
            label: t('peek.last_sold'),
            value: data.lastSale ? (
              <span>
                {formatBusinessDate(
                  data.lastSale.date,
                  i18n.language,
                  timeZone,
                )}
                {' · '}
                <bdi dir="ltr">{data.lastSale.invoice}</bdi>
              </span>
            ) : (
              dash
            ),
          },
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
        ]}
      />
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
          detail.lines.slice(0, 3).map((line) => (
            <PeekRow
              key={String(line.line.id)}
              label={
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
              }
              value={<MoneyText paisa={billLineTotal(detail, line.line)} />}
            />
          ))
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
