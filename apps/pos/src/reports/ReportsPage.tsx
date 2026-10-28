import { businessDate, mulDivRound } from '@bikri/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { ReportsIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { type ReportBundle, reportBundle } from '../data/reportBundle.ts';
import { type ReportTab, reportCsv } from '../data/reportCsv.ts';
import { rangeFor, shopTimeZone } from '../data/salesHistory.ts';
import { downloadText } from '../lib/download.ts';
import { downloadBlob } from '../print/receiptImage.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { DailyChart, PaymentDonut } from './charts.tsx';
import {
  bucketLabel,
  categoryName,
  daysBetween,
  groupName,
  longDate,
  percentText,
  qtyText,
} from './format.ts';
import { type ReportFileMeta, reportPdf, reportPng } from './reportFile.ts';

type Preset =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'month'
  | 'last_month'
  | 'custom';

const PRESETS: { id: Preset; key: string }[] = [
  { id: 'today', key: 'office.reports.range_today' },
  { id: 'yesterday', key: 'office.reports.range_yesterday' },
  { id: '7d', key: 'office.reports.range_7d' },
  { id: '30d', key: 'office.reports.range_30d' },
  { id: 'month', key: 'office.reports.range_month' },
  { id: 'last_month', key: 'office.reports.range_last_month' },
  { id: 'custom', key: 'office.reports.range_custom' },
];

const TABS: { id: ReportTab; key: string }[] = [
  { id: 'summary', key: 'office.reports.tab_summary' },
  { id: 'products', key: 'office.reports.tab_products' },
  { id: 'stock', key: 'office.reports.tab_stock' },
  { id: 'udhaar', key: 'office.reports.tab_udhaar' },
  { id: 'staff', key: 'office.reports.tab_staff' },
  { id: 'day_closes', key: 'office.reports.tab_day_closes' },
  { id: 'expenses', key: 'office.reports.tab_expenses' },
];

const field =
  'h-11 min-w-0 rounded-control border border-border-strong bg-surface px-2 text-text';

/** Reports for one range, computed on the device (screens/16). */
export function ReportsPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { role, can, support } = useCurrentStaff();
  const limited = role === 'cashier' && !support;
  const cost = can('cost.view');
  const exportable = can('export.data');
  const [preset, setPreset] = useState<Preset>('today');
  const [custom, setCustom] = useState(() => {
    const today = businessDate(Date.now());
    return { from: today, to: today };
  });
  const [deviceId, setDeviceId] = useState('');
  const [tab, setTab] = useState<ReportTab>('summary');

  const data = useLiveQuery(async () => {
    const db = getDb();
    const timeZone = await shopTimeZone(db);
    const now = Date.now();
    const today = businessDate(now, timeZone);
    const selected = limited ? 'today' : preset;
    if (
      selected === 'custom' &&
      (custom.from > custom.to || daysBetween(custom.from, custom.to) > 366)
    )
      return null;
    const range = reportRange(selected, now, timeZone, custom);
    const bundle = await reportBundle(
      db,
      { ...range, deviceId: deviceId || undefined },
      { now, today },
    );
    const devices = (await db.devices.toArray())
      .filter((device) => !device.deleted_at)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const shop = await db.shop.get('shop');
    return {
      bundle,
      today,
      timeZone,
      devices,
      shopName: String(shop?.name ?? ''),
    };
  }, [preset, custom.from, custom.to, deviceId, limited]);

  if (!can('report.view'))
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.reports.no_permission')}
      </p>
    );

  if (data === undefined)
    return <p className="sr-only">{t('common.loading')}</p>;
  if (data === null)
    return (
      <div className="mx-auto max-w-5xl p-4">
        <h1 className="text-h1 font-semibold">{t('office.reports.title')}</h1>
        <p className="mt-2 rounded-card bg-warning-subtle p-3 text-warning-subtle-ink">
          {t('office.reports.range_too_long')}
        </p>
      </div>
    );

  const bundle = data.bundle;
  const lang = i18n.language;
  const meta: ReportFileMeta = {
    shopName: data.shopName,
    from: bundle.range.from,
    to: bundle.range.to,
    generatedAt: Date.now(),
    lang,
    showProfit: cost,
    bundle,
    labels: {
      title: t('office.reports.title'),
      range: t('office.reports.pdf_range'),
      generated: t('office.reports.pdf_generated'),
      sold: t('office.reports.sold'),
      bills: t('office.reports.bills'),
      avgBill: t('office.reports.avg_bill'),
      grossProfit: t('office.reports.gross_profit'),
      expenses: t('office.reports.expenses'),
      netProfit: t('office.reports.net_profit'),
      margin: t('office.reports.margin'),
      tax: t('office.reports.tax_collected'),
      paymentMix: t('office.reports.payment_mix'),
      chartSold: t('office.reports.chart_sold'),
      chartProfit: t('office.reports.chart_profit'),
      udhaarGiven: t('office.reports.udhaar_given'),
      udhaarReceived: t('office.reports.udhaar_received'),
      methods: {
        cash: t('payment.cash'),
        card: t('payment.card'),
        bank_wallet: t('payment.bank_wallet'),
        udhaar: t('payment.udhaar'),
      },
    },
  };
  const exportCurrent = () => {
    const csv = reportCsv(tab, bundle, { includeCost: cost });
    downloadText(
      `bikri-report-${tab}-${bundle.range.from}-${bundle.range.to}.csv`,
      csv,
    );
  };
  const exportPdf = async () => {
    downloadBlob(
      await reportPdf(meta),
      `bikri-report-${bundle.range.from}-${bundle.range.to}.pdf`,
    );
  };
  const share = async () => {
    try {
      const png = await reportPng(meta);
      const file = new File(
        [png],
        `bikri-report-${bundle.range.from}-${bundle.range.to}.png`,
        { type: 'image/png' },
      );
      if (navigator.canShare?.({ files: [file] }))
        await navigator.share({
          files: [file],
          title: t('office.reports.title'),
        });
      else {
        downloadBlob(png, file.name);
        toast.push(t('done.image_saved'));
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        toast.push(t('done.share_failed'), 'error');
    }
  };

  return (
    <div
      className="mx-auto flex max-w-6xl flex-col gap-3 p-4"
      data-testid="reports-page"
    >
      <PageHeader
        icon={<ReportsIcon />}
        tone="bg-info-subtle text-info-subtle-ink"
        title={t('office.reports.title')}
        subtitle={t('office.reports.subtitle')}
        actions={
          <>
            <label className="flex items-center gap-1 text-small">
              <span className="text-text-muted">
                {t('office.reports.device')}
              </span>
              <select
                className={field}
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
              >
                <option value="">{t('office.reports.all_devices')}</option>
                {data.devices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {String(device.name ?? device.code ?? '')}
                  </option>
                ))}
              </select>
            </label>
            {exportable ? (
              <ExportMenu
                onCsv={exportCurrent}
                onPdf={() => void exportPdf()}
                onShare={() => void share()}
              />
            ) : null}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-1">
        {(limited
          ? PRESETS.filter((item) => item.id === 'today')
          : PRESETS
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={preset === item.id}
            className={`${buttonQuiet} px-3 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-ink`}
            onClick={() => setPreset(item.id)}
          >
            {t(item.key)}
          </button>
        ))}
        {preset === 'custom' && !limited ? (
          <span className="flex flex-wrap items-center gap-1">
            <label className="flex items-center gap-1 text-small">
              {t('office.reports.from')}
              <input
                type="date"
                className={field}
                value={custom.from}
                max={data.today}
                onChange={(event) =>
                  setCustom((current) => ({
                    ...current,
                    from: event.target.value,
                  }))
                }
              />
            </label>
            <label className="flex items-center gap-1 text-small">
              {t('office.reports.to')}
              <input
                type="date"
                className={field}
                value={custom.to}
                min={custom.from}
                max={data.today}
                onChange={(event) =>
                  setCustom((current) => ({
                    ...current,
                    to: event.target.value,
                  }))
                }
              />
            </label>
          </span>
        ) : null}
        <span className="ms-auto text-small text-text-muted">
          {longDate(bundle.range.from, lang)} –{' '}
          {longDate(bundle.range.to, lang)}
        </span>
      </div>

      <div
        role="tablist"
        aria-label={t('office.reports.title')}
        className="flex flex-wrap gap-1"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`report-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`report-panel-${item.id}`}
            data-testid={`report-tab-${item.id}`}
            className="inline-flex min-h-11 items-center rounded-control px-3 aria-selected:bg-primary-subtle aria-selected:text-primary-subtle-ink"
            onClick={() => setTab(item.id)}
          >
            {t(item.key)}
          </button>
        ))}
      </div>

      <section
        role="tabpanel"
        id={`report-panel-${tab}`}
        aria-labelledby={`report-tab-${tab}`}
        className="flex flex-col gap-3"
      >
        {tab === 'summary' ? (
          <SummaryTab bundle={bundle} cost={cost} lang={lang} />
        ) : null}
        {tab === 'products' ? (
          <ProductsTab bundle={bundle} cost={cost} lang={lang} />
        ) : null}
        {tab === 'stock' ? (
          <StockTab bundle={bundle} cost={cost} lang={lang} />
        ) : null}
        {tab === 'udhaar' ? <UdhaarTab bundle={bundle} lang={lang} /> : null}
        {tab === 'staff' ? <StaffTab bundle={bundle} /> : null}
        {tab === 'day_closes' ? (
          <DayCloseTab bundle={bundle} lang={lang} />
        ) : null}
        {tab === 'expenses' ? (
          <ExpensesTab bundle={bundle} lang={lang} />
        ) : null}
      </section>
    </div>
  );
}

function reportRange(
  preset: Preset,
  now: number,
  timeZone: string,
  custom: { from: string; to: string },
): { from: string; to: string } {
  if (preset === 'last_month') {
    const today = businessDate(now, timeZone);
    const firstThisMonth = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    const end = new Date(firstThisMonth.getTime() - 86_400_000);
    const start = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1),
    );
    return {
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
    };
  }
  if (preset === 'custom') return custom;
  return rangeFor(preset, now, timeZone);
}

function Card({
  label,
  value,
  testId,
}: {
  label: string;
  value: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-card border border-border bg-surface p-3"
      data-testid={testId}
    >
      <p className="text-small text-text-muted">{label}</p>
      <p className="text-title font-semibold">{value}</p>
    </div>
  );
}

function NoRows({ message }: { message: string }) {
  return (
    <p className="rounded-card border border-border bg-surface p-4 text-center text-small text-text-muted">
      {message}
    </p>
  );
}

function ReportTable({
  title,
  headers,
  rows,
  empty,
  testId,
  rowKeys,
}: {
  title: string;
  headers: readonly string[];
  rows: readonly ReactNode[][];
  empty: string;
  testId?: string;
  rowKeys?: readonly string[];
}) {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h2 className="text-title font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <NoRows message={empty} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-border bg-surface">
          <table className="w-full min-w-[36rem] border-collapse text-small">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-start">
                {headers.map((header) => (
                  <th
                    key={header}
                    scope="col"
                    className="px-3 py-2 text-start font-medium"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={rowKeys?.[index] ?? String(row[0])}
                  className="border-b border-border last:border-0"
                >
                  {row.map((cell, cellIndex) => (
                    <td
                      key={headers[cellIndex]}
                      className={`px-3 py-2 ${cellIndex === 0 ? '' : 'text-end'}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SummaryTab({
  bundle,
  cost,
  lang,
}: {
  bundle: ReportBundle;
  cost: boolean;
  lang: string;
}) {
  const { t } = useTranslation();
  const summary = bundle.summary;
  const hasActivity =
    summary.bills > 0 ||
    summary.refundCount > 0 ||
    summary.expenses !== 0 ||
    summary.sold !== 0 ||
    summary.udhaarGiven !== 0 ||
    summary.udhaarReceived !== 0 ||
    summary.paymentMix.card !== 0 ||
    summary.paymentMix.bank_wallet !== 0;
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <li>
          <Card
            label={t('office.reports.sold')}
            testId="report-sold"
            value={<MoneyText paisa={summary.sold} />}
          />
        </li>
        <li>
          <Card
            label={t('office.reports.bills')}
            testId="report-bills"
            value={summary.bills}
          />
        </li>
        <li>
          <Card
            label={t('office.reports.avg_bill')}
            value={<MoneyText paisa={summary.avgBill} />}
          />
        </li>
        <li>
          <Card
            label={t('office.reports.expenses')}
            value={<MoneyText paisa={summary.expenses} />}
          />
        </li>
        {cost ? (
          <>
            <li>
              <Card
                label={t('office.reports.gross_profit')}
                testId="report-profit"
                value={<MoneyText paisa={summary.grossProfit} />}
              />
            </li>
            <li>
              <Card
                label={t('office.reports.net_profit')}
                value={<MoneyText paisa={summary.netProfit} />}
              />
            </li>
            <li>
              <Card
                label={t('office.reports.margin')}
                value={percentText(summary.marginBp)}
              />
            </li>
          </>
        ) : null}
        {bundle.taxEnabled || summary.tax !== 0 ? (
          <li>
            <Card
              label={t('office.reports.tax_collected')}
              value={<MoneyText paisa={summary.tax} />}
            />
          </li>
        ) : null}
      </ul>

      {!hasActivity ? (
        <EmptyState
          icon={<ReportsIcon />}
          message={t('office.reports.no_data')}
        />
      ) : (
        <>
          <section className="rounded-card border border-border bg-surface p-3">
            <h2 className="mb-2 text-title font-semibold">
              {t('office.reports.daily_chart')}
            </h2>
            <DailyChart
              points={summary.daily}
              showProfit={cost}
              lang={lang}
              t={t}
            />
          </section>

          <div className="grid gap-3 lg:grid-cols-2">
            <section className="rounded-card border border-border bg-surface p-3">
              <h2 className="mb-2 text-title font-semibold">
                {t('office.reports.payment_mix')}
              </h2>
              <PaymentDonut mix={summary.paymentMix} t={t} />
            </section>
            <section className="rounded-card border border-border bg-surface p-3">
              <h2 className="mb-2 text-title font-semibold">
                {t('office.reports.udhaar')}
              </h2>
              <dl className="grid grid-cols-2 gap-3 text-small">
                <div>
                  <dt className="text-text-muted">
                    {t('office.reports.udhaar_given')}
                  </dt>
                  <dd className="text-title font-semibold">
                    <MoneyText paisa={summary.udhaarGiven} />
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">
                    {t('office.reports.udhaar_received')}
                  </dt>
                  <dd className="text-title font-semibold">
                    <MoneyText paisa={summary.udhaarReceived} />
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-small text-text-muted">
                {t('office.reports.refunds_note', {
                  count: summary.refundCount,
                  amount: (summary.refunded / 100).toFixed(2),
                })}
              </p>
            </section>
          </div>
        </>
      )}
    </>
  );
}

function ProductsTab({
  bundle,
  cost,
  lang,
}: {
  bundle: ReportBundle;
  cost: boolean;
  lang: string;
}) {
  const { t } = useTranslation();
  const products = bundle.products;
  const name = (row: { name: string; nameUr?: string }) =>
    groupName({ name: row.name, nameUr: row.nameUr ?? '' }, lang);
  return (
    <>
      <ReportTable
        title={t('office.reports.best_qty')}
        testId="report-best-qty"
        headers={[
          t('office.reports.product'),
          t('office.reports.qty'),
          t('office.reports.revenue'),
        ]}
        rows={products.bestByQty.map((row) => [
          name(row),
          qtyText(row.qtyMilli, row.unit),
          <MoneyText key="revenue" paisa={row.revenue} />,
        ])}
        empty={t('office.reports.no_products')}
      />
      <ReportTable
        title={t('office.reports.best_revenue')}
        headers={[
          t('office.reports.product'),
          t('office.reports.qty'),
          t('office.reports.revenue'),
        ]}
        rows={products.bestByRevenue.map((row) => [
          name(row),
          qtyText(row.qtyMilli, row.unit),
          <MoneyText key="revenue" paisa={row.revenue} />,
        ])}
        empty={t('office.reports.no_products')}
      />
      {cost ? (
        <ReportTable
          title={t('office.reports.profit_by_product')}
          headers={[
            t('office.reports.product'),
            t('office.reports.revenue'),
            t('office.reports.cost'),
            t('office.reports.profit'),
            t('office.reports.margin'),
          ]}
          rows={products.bestByProfit.map((row) => [
            name(row),
            <MoneyText key="revenue" paisa={row.revenue} />,
            <MoneyText key="cost" paisa={row.cost} />,
            <MoneyText key="profit" paisa={row.profit} />,
            row.revenue > 0
              ? percentText(mulDivRound(row.profit, 10000, row.revenue))
              : '—',
          ])}
          empty={t('office.reports.no_products')}
        />
      ) : null}
      <ReportTable
        title={t('office.reports.by_category')}
        headers={[
          t('office.reports.category'),
          t('office.reports.qty'),
          t('office.reports.revenue'),
        ]}
        rows={products.categories.map((row) => [
          row.key === 'none'
            ? t('office.reports.uncategorized')
            : groupName(row, lang),
          qtyText(row.qtyMilli),
          <MoneyText key="revenue" paisa={row.revenue} />,
        ])}
        empty={t('office.reports.no_products')}
      />
      <ReportTable
        title={t('office.reports.by_brand')}
        headers={[
          t('office.reports.brand'),
          t('office.reports.qty'),
          t('office.reports.revenue'),
        ]}
        rows={products.brands.map((row) => [
          row.key === '' ? t('office.reports.no_brand') : row.name,
          qtyText(row.qtyMilli),
          <MoneyText key="revenue" paisa={row.revenue} />,
        ])}
        empty={t('office.reports.no_products')}
      />
      <ReportTable
        title={t('office.reports.slow_movers')}
        testId="report-slow-movers"
        headers={[
          t('office.reports.product'),
          t('office.reports.on_hand'),
          t('office.reports.last_sale'),
        ]}
        rows={products.slowMovers.map((row) => [
          String(row.product.name_en),
          qtyText(row.onHand, String(row.product.unit ?? 'pc')),
          row.lastSale
            ? longDate(row.lastSale, lang)
            : t('office.reports.never_sold'),
        ])}
        empty={t('office.reports.no_slow_movers')}
      />
    </>
  );
}

function StockTab({
  bundle,
  cost,
  lang,
}: {
  bundle: ReportBundle;
  cost: boolean;
  lang: string;
}) {
  const { t } = useTranslation();
  const stock = bundle.stock;
  const statusLabel = (status: string) => t(`office.reports.status_${status}`);
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cost ? (
          <li>
            <Card
              label={t('office.reports.stock_value')}
              value={<MoneyText paisa={stock.value} />}
            />
          </li>
        ) : null}
        <li>
          <Card
            label={t('office.reports.low_stock')}
            value={stock.lowStock.length}
          />
        </li>
        <li>
          <Card
            label={t('office.reports.out_of_stock')}
            value={stock.outOfStock.length}
          />
        </li>
        <li>
          <Card
            label={t('office.reports.negative_stock')}
            value={stock.negativeStock.length}
          />
        </li>
      </ul>

      <ReportTable
        title={t('office.reports.needs_attention')}
        testId="report-stock-attention"
        headers={[
          t('office.reports.product'),
          t('office.reports.on_hand'),
          t('office.reports.min_stock'),
          t('office.reports.status'),
          ...(cost ? [t('office.reports.stock_value')] : []),
        ]}
        rows={stock.attention.map((row) => [
          String(row.product.name_en),
          qtyText(row.onHand, String(row.product.unit ?? 'pc')),
          qtyText(Number(row.product.min_stock_milli ?? 0)),
          statusLabel(row.status),
          ...(cost ? [<MoneyText key="value" paisa={row.value} />] : []),
        ])}
        empty={t('office.reports.no_stock_issues')}
      />

      <ReportTable
        title={t('office.reports.movement_summary')}
        headers={[
          t('office.reports.reason'),
          t('office.reports.movements'),
          t('office.reports.in_qty'),
          t('office.reports.out_qty'),
          t('office.reports.net_qty'),
        ]}
        rows={stock.movements.map((row) => [
          t(`stock.reason.${row.reason}`),
          row.count,
          qtyText(row.inQty),
          qtyText(row.outQty),
          qtyText(row.netQty),
        ])}
        empty={t('office.reports.no_movements')}
      />

      <section className="flex flex-col gap-2">
        <h2 className="text-title font-semibold">
          {t('office.reports.supplier_returns')}
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <li>
            <Card
              label={t('office.reports.returns_count')}
              value={stock.supplierReturns.count}
            />
          </li>
          <li>
            <Card
              label={t('office.reports.returns_credit')}
              value={<MoneyText paisa={stock.supplierReturns.credit} />}
            />
          </li>
          <li>
            <Card
              label={t('office.reports.returns_difference')}
              value={<MoneyText paisa={stock.supplierReturns.difference} />}
            />
          </li>
        </ul>
        <p className="text-small text-text-muted">
          {t('office.reports.returns_hint')}
        </p>
        {stock.supplierReturns.rows.length > 0 ? (
          <ReportTable
            title={t('office.reports.supplier_returns')}
            headers={[
              t('office.reports.date'),
              t('office.reports.supplier'),
              t('office.reports.credit'),
              t('office.reports.returns_difference'),
            ]}
            rowKeys={stock.supplierReturns.rows.map(
              (row) => `${row.date}-${row.supplierId}`,
            )}
            rows={stock.supplierReturns.rows.map((row) => [
              longDate(row.date, lang),
              row.supplierName,
              <MoneyText key="credit" paisa={row.total} />,
              <MoneyText key="difference" paisa={row.difference} />,
            ])}
            empty={t('office.reports.no_returns')}
          />
        ) : null}
      </section>
    </>
  );
}

function UdhaarTab({ bundle, lang }: { bundle: ReportBundle; lang: string }) {
  const { t } = useTranslation();
  const udhaar = bundle.udhaar;
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <li>
          <Card
            label={t('office.reports.total_owed')}
            testId="report-udhaar-total"
            value={<MoneyText paisa={udhaar.totalOwed} />}
          />
        </li>
        <li>
          <Card
            label={t('office.reports.customers_owing')}
            value={udhaar.count}
          />
        </li>
      </ul>
      <p className="text-small text-text-muted">
        {t('office.reports.udhaar_range_note')}
      </p>
      <ReportTable
        title={t('office.reports.aging')}
        headers={[
          t('office.reports.bucket'),
          t('office.reports.customers'),
          t('office.reports.balance'),
        ]}
        rowKeys={udhaar.buckets.map((bucket) => bucket.key)}
        rows={udhaar.buckets.map((bucket) => [
          bucketLabel(t, bucket.key),
          bucket.count,
          <MoneyText key="balance" paisa={bucket.total} />,
        ])}
        empty={t('office.reports.no_udhaar')}
      />
      <ReportTable
        title={t('office.reports.top_debtors')}
        testId="report-top-debtors"
        headers={[
          t('office.reports.customer'),
          t('office.reports.phone'),
          t('office.reports.balance'),
          t('office.reports.age_days'),
          t('office.reports.promise_date'),
        ]}
        rowKeys={udhaar.top.map((row) => String(row.customer.id))}
        rows={udhaar.top.map((row) => [
          String(row.customer.name),
          <span key="phone" dir="ltr">
            {String(row.customer.phone ?? '')}
          </span>,
          <MoneyText key="balance" paisa={row.balance} />,
          row.ageDays,
          row.promiseDate ? longDate(row.promiseDate, lang) : '—',
        ])}
        empty={t('office.reports.no_udhaar')}
      />
    </>
  );
}

function StaffTab({ bundle }: { bundle: ReportBundle }) {
  const { t } = useTranslation();
  return (
    <ReportTable
      title={t('office.reports.tab_staff')}
      testId="report-staff"
      headers={[
        t('office.reports.cashier'),
        t('office.reports.bills'),
        t('office.reports.sold'),
        t('office.reports.discounts'),
        t('office.reports.refunds'),
        t('office.reports.refunded_amount'),
        t('office.reports.voids'),
        t('office.reports.voided_amount'),
        t('office.reports.net_sold'),
      ]}
      rowKeys={bundle.staff.map((row) => row.staffId)}
      rows={bundle.staff.map((row) => [
        row.name,
        row.bills,
        <MoneyText key="sold" paisa={row.sold} />,
        <MoneyText key="discounts" paisa={row.discounts} />,
        row.refunds,
        <MoneyText key="refunded" paisa={row.refunded} />,
        row.voids,
        <MoneyText key="voided" paisa={row.voided} />,
        <MoneyText key="net" paisa={row.netSold} />,
      ])}
      empty={t('office.reports.no_staff')}
    />
  );
}

function DayCloseTab({ bundle, lang }: { bundle: ReportBundle; lang: string }) {
  const { t } = useTranslation();
  const closes = bundle.dayCloses;
  return (
    <>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <li>
          <Card label={t('office.reports.closes')} value={closes.rows.length} />
        </li>
        <li>
          <Card
            label={t('office.reports.expected')}
            value={<MoneyText paisa={closes.expected} />}
          />
        </li>
        <li>
          <Card
            label={t('office.reports.counted')}
            value={<MoneyText paisa={closes.counted} />}
          />
        </li>
        <li>
          <Card
            label={t('office.reports.shorts')}
            value={
              <span>
                {closes.shortCount} · <MoneyText paisa={closes.shortTotal} />
              </span>
            }
          />
        </li>
        <li>
          <Card
            label={t('office.reports.overs')}
            value={
              <span>
                {closes.overCount} · <MoneyText paisa={closes.overTotal} />
              </span>
            }
          />
        </li>
      </ul>
      <ReportTable
        title={t('office.reports.tab_day_closes')}
        testId="report-day-closes"
        headers={[
          t('office.reports.date'),
          t('office.reports.device'),
          t('office.reports.cashier'),
          t('office.reports.expected'),
          t('office.reports.counted'),
          t('office.reports.difference'),
        ]}
        rowKeys={closes.rows.map((row) => String(row.close.id))}
        rows={closes.rows.map((row) => [
          longDate(String(row.close.business_date), lang),
          row.deviceName,
          row.staffName,
          <MoneyText key="expected" paisa={Number(row.close.expected_cash)} />,
          <MoneyText key="counted" paisa={Number(row.close.counted_cash)} />,
          <span
            key="difference"
            className={
              Number(row.close.difference) === 0
                ? 'text-success-subtle-ink'
                : Number(row.close.difference) < 0
                  ? 'text-danger'
                  : 'text-warning-subtle-ink'
            }
          >
            <MoneyText paisa={Number(row.close.difference)} />
          </span>,
        ])}
        empty={t('office.reports.no_closes')}
      />
    </>
  );
}

function ExpensesTab({ bundle, lang }: { bundle: ReportBundle; lang: string }) {
  const { t } = useTranslation();
  return (
    <>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <li>
          <Card
            label={t('office.reports.total_expenses')}
            testId="report-expenses-total"
            value={<MoneyText paisa={bundle.expenses.total} />}
          />
        </li>
      </ul>
      <ReportTable
        title={t('office.reports.expenses_by_category')}
        testId="report-expenses"
        headers={[
          t('office.reports.category'),
          t('office.reports.amount'),
          t('office.reports.share'),
        ]}
        rowKeys={bundle.expenses.rows.map((row) =>
          String(row.category?.id ?? 'none'),
        )}
        rows={bundle.expenses.rows.map((row) => [
          row.category
            ? categoryName(row.category, lang)
            : t('office.reports.uncategorized'),
          <MoneyText key="amount" paisa={row.amount} />,
          percentText(row.shareBp),
        ])}
        empty={t('office.reports.no_expenses')}
      />
    </>
  );
}
