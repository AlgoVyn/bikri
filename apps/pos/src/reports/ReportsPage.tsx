import { businessDate, mulDivRound } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/EmptyState.tsx';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { ReportsIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { PageLoading } from '../components/PageLoading';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { type ReportBundle, reportBundle } from '../data/reportBundle.ts';
import { type ReportTab, reportCsv } from '../data/reportCsv.ts';
import { rangeFor, shopTimeZone } from '../data/salesHistory.ts';
import { readDateFilter, rememberDateFilter } from '../lib/dateFilter.ts';
import { downloadText } from '../lib/download.ts';
import { formatShopMoney } from '../lib/money';
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

const REPORT_PRESET_IDS: Preset[] = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'month',
  'last_month',
  'custom',
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

/** Reports for one range, computed on the device (screens/16). */
export function ReportsPage() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { role, can, support } = useCurrentStaff();
  const limited = role === 'cashier' && !support;
  const cost = can('cost.view');
  const exportable = can('export.data');
  const [stored] = useState(() =>
    readDateFilter(
      'reports',
      limited ? (['today'] as Preset[]) : REPORT_PRESET_IDS,
      'today',
      businessDate(Date.now()),
    ),
  );
  const [preset, setPreset] = useState<Preset>(stored.preset);
  const [custom, setCustom] = useState({
    from: stored.from,
    to: stored.to,
  });
  const [deviceId, setDeviceId] = useState('');
  const [tab, setTab] = useState<ReportTab>('summary');

  useEffect(() => {
    if (!limited) rememberDateFilter('reports', preset, custom.from, custom.to);
  }, [preset, custom.from, custom.to, limited]);

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

  if (data === undefined) return <PageLoading compact />;
  if (data === null)
    return (
      <Box mx="auto" maw={1024} p="md">
        <Title order={1} fz="h2">
          {t('office.reports.title')}
        </Title>
        <Paper p="sm" mt="sm" bg="var(--mantine-color-warning-subtle)">
          <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
            {t('office.reports.range_too_long')}
          </Text>
        </Paper>
      </Box>
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
    <Box mx="auto" maw={1152} p="md" w="100%" data-testid="reports-page">
      <Stack gap="sm">
        <PageHeader
          icon={<ReportsIcon />}
          tone="bg-info-subtle text-info-subtle-ink"
          title={t('office.reports.title')}
          subtitle={t('office.reports.subtitle')}
          actions={
            <>
              <NativeSelect
                aria-label={t('office.reports.device')}
                value={deviceId}
                onChange={(event) => setDeviceId(event.currentTarget.value)}
                data={[
                  { value: '', label: t('office.reports.all_devices') },
                  ...data.devices.map((device) => ({
                    value: device.id,
                    label: String(device.name ?? device.code ?? ''),
                  })),
                ]}
              />
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

        <Paper withBorder p="sm">
          <Group justify="space-between" gap="sm" wrap="wrap">
            <Group gap="xs" align="flex-end">
              {(limited
                ? PRESETS.filter((item) => item.id === 'today')
                : PRESETS
              ).map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  size="compact-sm"
                  variant={preset === item.id ? 'light' : 'default'}
                  aria-pressed={preset === item.id}
                  onClick={() => setPreset(item.id)}
                >
                  {t(item.key)}
                </Button>
              ))}
              {preset === 'custom' && !limited ? (
                <>
                  <TextInput
                    type="date"
                    label={t('office.reports.from')}
                    value={custom.from}
                    max={data.today}
                    onChange={(event) =>
                      setCustom((current) => ({
                        ...current,
                        from: event.currentTarget.value,
                      }))
                    }
                  />
                  <TextInput
                    type="date"
                    label={t('office.reports.to')}
                    value={custom.to}
                    min={custom.from}
                    max={data.today}
                    onChange={(event) =>
                      setCustom((current) => ({
                        ...current,
                        to: event.currentTarget.value,
                      }))
                    }
                  />
                </>
              ) : null}
            </Group>
            <Text size="sm" c="dimmed">
              {longDate(bundle.range.from, lang)} –{' '}
              {longDate(bundle.range.to, lang)}
            </Text>
          </Group>
        </Paper>

        <Tabs
          value={tab}
          onChange={(value) => setTab((value ?? 'summary') as ReportTab)}
          aria-label={t('office.reports.title')}
        >
          <Tabs.List>
            {TABS.map((item) => (
              <Tabs.Tab
                key={item.id}
                value={item.id}
                data-testid={`report-tab-${item.id}`}
              >
                {t(item.key)}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <Tabs.Panel value={tab} pt="sm">
            {tab === 'summary' ? (
              <SummaryTab bundle={bundle} cost={cost} lang={lang} />
            ) : null}
            {tab === 'products' ? (
              <ProductsTab bundle={bundle} cost={cost} lang={lang} />
            ) : null}
            {tab === 'stock' ? (
              <StockTab bundle={bundle} cost={cost} lang={lang} />
            ) : null}
            {tab === 'udhaar' ? (
              <UdhaarTab bundle={bundle} lang={lang} />
            ) : null}
            {tab === 'staff' ? <StaffTab bundle={bundle} /> : null}
            {tab === 'day_closes' ? (
              <DayCloseTab bundle={bundle} lang={lang} />
            ) : null}
            {tab === 'expenses' ? (
              <ExpensesTab bundle={bundle} lang={lang} />
            ) : null}
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Box>
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
  flat = false,
}: {
  label: string;
  value: ReactNode;
  testId?: string;
  flat?: boolean;
}) {
  const body = (
    <>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fz={24} fw={600}>
        {value}
      </Text>
    </>
  );
  if (flat) {
    return (
      <Box p="sm" data-testid={testId}>
        {body}
      </Box>
    );
  }
  return (
    <Paper withBorder p="sm" h="100%" data-testid={testId}>
      {body}
    </Paper>
  );
}

function NoRows({ message }: { message: string }) {
  return (
    <Paper withBorder p="md">
      <Text size="sm" c="dimmed" ta="center">
        {message}
      </Text>
    </Paper>
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
    <Box component="section" data-testid={testId}>
      <Stack gap="sm">
        <Title order={2} fz="md">
          {title}
        </Title>
        {rows.length === 0 ? (
          <NoRows message={empty} />
        ) : (
          <Paper withBorder>
            <Box
              tabIndex={0}
              role="region"
              aria-label={title}
              style={{ overflowX: 'auto' }}
            >
              <Table fz="sm" miw={576}>
                <Table.Thead>
                  <Table.Tr>
                    {headers.map((header, headerIndex) => (
                      <Table.Th
                        key={header}
                        scope="col"
                        ta={headerIndex === 0 ? 'start' : 'end'}
                      >
                        {header}
                      </Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((row, index) => (
                    <Table.Tr key={rowKeys?.[index] ?? String(row[0])}>
                      {row.map((cell, cellIndex) => (
                        <Table.Td
                          key={headers[cellIndex]}
                          ta={cellIndex === 0 ? 'start' : 'end'}
                        >
                          {cell}
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Box>
          </Paper>
        )}
      </Stack>
    </Box>
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
      <Paper withBorder p="sm">
        <Box
          component="ul"
          className="grid grid-cols-2 gap-3 lg:grid-cols-4"
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
        >
          <li className="min-w-0">
            <Card
              flat
              label={t('office.reports.sold')}
              testId="report-sold"
              value={<MoneyText paisa={summary.sold} />}
            />
          </li>
          <li className="min-w-0">
            <Card
              flat
              label={t('office.reports.bills')}
              testId="report-bills"
              value={summary.bills}
            />
          </li>
          <li className="min-w-0">
            <Card
              flat
              label={t('office.reports.avg_bill')}
              value={<MoneyText paisa={summary.avgBill} />}
            />
          </li>
          <li className="min-w-0">
            <Card
              flat
              label={t('office.reports.expenses')}
              value={<MoneyText paisa={summary.expenses} />}
            />
          </li>
          {cost ? (
            <>
              <li className="min-w-0">
                <Card
                  flat
                  label={t('office.reports.gross_profit')}
                  testId="report-profit"
                  value={<MoneyText paisa={summary.grossProfit} />}
                />
              </li>
              <li className="min-w-0">
                <Card
                  flat
                  label={t('office.reports.net_profit')}
                  value={<MoneyText paisa={summary.netProfit} />}
                />
              </li>
              <li className="min-w-0">
                <Card
                  flat
                  label={t('office.reports.margin')}
                  value={percentText(summary.marginBp)}
                />
              </li>
            </>
          ) : null}
          {bundle.taxEnabled || summary.tax !== 0 ? (
            <li className="min-w-0">
              <Card
                flat
                label={t('office.reports.tax_collected')}
                value={<MoneyText paisa={summary.tax} />}
              />
            </li>
          ) : null}
        </Box>
      </Paper>

      {!hasActivity ? (
        <EmptyState
          icon={<ReportsIcon />}
          message={t('office.reports.no_data')}
        />
      ) : (
        <>
          <Paper withBorder p="sm">
            <Title order={2} fz="md" mb="xs">
              {t('office.reports.daily_chart')}
            </Title>
            {summary.daily.filter(
              (point) => point.sold !== 0 || point.grossProfit !== 0,
            ).length > 1 ? (
              <DailyChart
                points={summary.daily}
                showProfit={cost}
                lang={lang}
                t={t}
              />
            ) : (
              <Text size="sm" c="dimmed" ta="center" py="md">
                {t('office.reports.not_enough_days')}
              </Text>
            )}
          </Paper>

          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="sm">
            <Paper withBorder p="sm">
              <Title order={2} fz="md" mb="xs">
                {t('office.reports.payment_mix')}
              </Title>
              <PaymentDonut mix={summary.paymentMix} t={t} />
            </Paper>
            <Paper withBorder p="sm">
              <Title order={2} fz="md" mb="xs">
                {t('office.reports.udhaar')}
              </Title>
              <SimpleGrid cols={2} spacing="sm">
                <Box>
                  <Text size="sm" c="dimmed">
                    {t('office.reports.udhaar_given')}
                  </Text>
                  <Text fz={22} fw={600}>
                    <MoneyText paisa={summary.udhaarGiven} />
                  </Text>
                </Box>
                <Box>
                  <Text size="sm" c="dimmed">
                    {t('office.reports.udhaar_received')}
                  </Text>
                  <Text fz={22} fw={600}>
                    <MoneyText paisa={summary.udhaarReceived} />
                  </Text>
                </Box>
              </SimpleGrid>
              <Text size="sm" c="dimmed" mt="xs">
                {t('office.reports.refunds_note', {
                  count: summary.refundCount,
                  amount: formatShopMoney(summary.refunded),
                })}
              </Text>
            </Paper>
          </SimpleGrid>
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
