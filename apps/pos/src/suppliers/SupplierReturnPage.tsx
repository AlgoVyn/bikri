import { mulDivRound, newId } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageLoading } from '../components/PageLoading';
import { QtyInput } from '../components/QtyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { getKv } from '../data/kv.ts';
import type { PrinterKv } from '../data/receipt.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { queueSupplierReturnPrint } from '../data/supplierReturnReceipt.ts';
import {
  createSupplierReturn,
  SupplierReturnError,
  supplierReturnData,
} from '../data/supplierReturns.ts';
import { supplierBalance } from '../data/suppliers.ts';
import { formatShopMoney } from '../lib/money';
import { useCurrentStaff } from '../state/currentStaff.ts';

type Unlinked = {
  key: string;
  productId: string;
  name: string;
  qtyMilli: number;
  unitCredit: number;
  trackStock: boolean;
};

const REASONS = ['faulty', 'wrong_item', 'unsold', 'expired', 'other'] as const;
/** Return goods to a supplier (screens/13, 07 §10). */
export function SupplierReturnPage({
  supplierId,
  initialPurchaseId,
}: {
  supplierId: string;
  initialPurchaseId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const [purchaseId, setPurchaseId] = useState(initialPurchaseId ?? '');
  const [linkedQty, setLinkedQty] = useState<Record<string, number>>({});
  const [linkedCredit, setLinkedCredit] = useState<Record<string, number>>({});
  const [unlinked, setUnlinked] = useState<Unlinked[]>([]);
  const [query, setQuery] = useState('');
  const [reasonKey, setReasonKey] =
    useState<(typeof REASONS)[number]>('faulty');
  const [reasonText, setReasonText] = useState('');
  const [refundReceived, setRefundReceived] = useState<number | null>(null);
  const [refundTouched, setRefundTouched] = useState(false);
  const [refundMethod, setRefundMethod] = useState<'cash' | 'bank_wallet'>(
    'cash',
  );
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [returnId] = useState(() => newId());

  const data = useLiveQuery(async () => {
    const db = getDb();
    const tz = await shopTimeZone(db);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const result = await supplierReturnData(db, supplierId, today);
    if (!result) return null;
    const barcodes = await db.product_barcodes.toArray();
    const printer = await getKv<PrinterKv | null>(db, 'printer', null);
    return { ...result, today, tz, barcodes, printer };
  }, [supplierId]);

  const initializedPurchase = useRef<string | null>(null);
  useEffect(() => {
    if (!purchaseId) {
      initializedPurchase.current = null;
      return;
    }
    if (!data || initializedPurchase.current === purchaseId) return;
    const purchase = data.purchases.find(
      (row) => String(row.purchase.id) === purchaseId,
    );
    if (!purchase) return;
    initializedPurchase.current = purchaseId;
    setLinkedQty({});
    setLinkedCredit(
      Object.fromEntries(
        purchase.lines.map((line) => [
          String(line.purchaseLine.id),
          line.landedCost,
        ]),
      ),
    );
    setUnlinked([]);
  }, [purchaseId, data]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return [];
    const barcode = data.barcodes.find(
      (row) => String(row.barcode) === q && !row.deleted_at,
    );
    return data.products
      .filter(
        (product) =>
          product.id === barcode?.product_id ||
          String(product.name_en).toLowerCase().includes(q) ||
          String(product.sku).toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [query, data]);

  const purchase = data?.purchases.find(
    (row) => String(row.purchase.id) === purchaseId,
  );
  const selected = purchase
    ? purchase.lines
        .filter((line) => (linkedQty[String(line.purchaseLine.id)] ?? 0) > 0)
        .map((line) => {
          const qtyMilli = linkedQty[String(line.purchaseLine.id)] ?? 0;
          const unitCredit =
            linkedCredit[String(line.purchaseLine.id)] ?? line.landedCost;
          return {
            productId: String(line.product.id),
            purchaseLineId: String(line.purchaseLine.id),
            qtyMilli,
            unitCredit,
            lineTotal: mulDivRound(qtyMilli, unitCredit, 1000),
            name: String(line.product.name_en),
            unit: String(line.product.unit ?? 'pc'),
          };
        })
    : [];
  const allLines = [
    ...selected,
    ...unlinked.map((line) => ({
      productId: line.productId,
      purchaseLineId: null,
      qtyMilli: line.qtyMilli,
      unitCredit: line.unitCredit,
      lineTotal: mulDivRound(line.qtyMilli, line.unitCredit, 1000),
      name: line.name,
      unit: 'pc',
    })),
  ];
  const total = allLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const suggested = Math.max(0, total - Math.max(0, data?.balance ?? 0));
  useEffect(() => {
    if (!refundTouched) setRefundReceived(suggested);
  }, [suggested, refundTouched]);
  const reason =
    reasonKey === 'other'
      ? reasonText.trim()
      : t(`office.suppliers.return_reason_${reasonKey}`);
  const canSave =
    data !== null &&
    allLines.length > 0 &&
    reason.length > 0 &&
    reason.length <= 120 &&
    (refundReceived ?? 0) <= total &&
    !pending;

  const addProduct = (productId: string) => {
    const product = data?.products.find((row) => row.id === productId);
    if (!product) return;
    setUnlinked((current) => [
      ...current,
      {
        key: newId(),
        productId,
        name: String(product.name_en),
        qtyMilli: 1000,
        unitCredit: Number(product.avg_cost || product.last_cost || 0),
        trackStock: product.track_stock === 1,
      },
    ]);
    setQuery('');
  };

  const save = async () => {
    if (!data || !canSave) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      await createSupplierReturn(
        db,
        {
          returnId,
          supplierId,
          purchaseId: purchaseId || null,
          lines: allLines.map((line) => ({
            productId: line.productId,
            purchaseLineId: line.purchaseLineId,
            qtyMilli: line.qtyMilli,
            unitCredit: line.unitCredit,
          })),
          reason,
          refundReceived: refundReceived ?? 0,
          refundMethod: (refundReceived ?? 0) > 0 ? refundMethod : null,
          note,
        },
        ctx,
        { today: data.today },
      );
      if (data.printer && data.printer.auto_print !== false)
        await queueSupplierReturnPrint(db, returnId);
      const after = await supplierBalance(db, supplierId);
      toast.push(
        t('office.suppliers.return_saved', {
          count: allLines.length,
          total: formatShopMoney(total),
          balance: formatShopMoney(after),
        }),
      );
      void navigate({
        to: '/suppliers/$supplierId',
        params: { supplierId },
      });
    } catch (err) {
      toast.push(
        err instanceof SupplierReturnError
          ? t(`office.suppliers.return_error_${err.code}`)
          : t('errors.generic'),
        'error',
      );
    } finally {
      setPending(false);
    }
  };

  if (data === null)
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.suppliers.not_found')}
      </p>
    );
  if (!data) return <PageLoading compact />;

  return (
    <Box mx="auto" maw={896} p="md" w="100%">
      <Stack gap="sm">
        <Group gap="sm" wrap="wrap">
          <Link
            to="/suppliers/$supplierId"
            params={{ supplierId }}
            style={{ textDecoration: 'none' }}
          >
            <Button component="span" variant="default">
              {t('office.suppliers.back')}
            </Button>
          </Link>
          <Title order={1} fz="h2" style={{ marginInlineEnd: 'auto' }}>
            {t('office.suppliers.return_title')}
          </Title>
          <Text size="sm" c="dimmed">
            {String(data.supplier.name)} · <MoneyText paisa={data.balance} />
          </Text>
        </Group>

        <Paper withBorder p="sm">
          <NativeSelect
            label={t('office.suppliers.return_linked')}
            value={purchaseId}
            onChange={(event) => setPurchaseId(event.currentTarget.value)}
            data={[
              {
                value: '',
                label: t('office.suppliers.return_unlinked'),
              },
              ...data.purchases.map((row) => ({
                value: String(row.purchase.id),
                label: `${String(row.purchase.supplier_invoice_no || row.purchase.id)} · ${String(row.purchase.business_date)}`,
              })),
            ]}
          />
        </Paper>

        {purchase ? (
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Title order={2} fz="md">
                {t('office.suppliers.return_delivery_lines')}
              </Title>
              <Box
                tabIndex={0}
                role="region"
                aria-label={t('office.suppliers.return_delivery_lines')}
                style={{ overflowX: 'auto' }}
              >
                <Table fz="sm" miw={640}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('office.suppliers.product')}</Table.Th>
                      <Table.Th ta="end">
                        {t('office.suppliers.received')}
                      </Table.Th>
                      <Table.Th ta="end">
                        {t('office.suppliers.returned')}
                      </Table.Th>
                      <Table.Th>{t('office.suppliers.return_qty')}</Table.Th>
                      {can('cost.view') ? (
                        <Table.Th>{t('office.suppliers.credit_unit')}</Table.Th>
                      ) : null}
                      <Table.Th ta="end">
                        {t('office.suppliers.line_total')}
                      </Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {purchase.lines.map((line) => {
                      const key = String(line.purchaseLine.id);
                      const qty = linkedQty[key] ?? 0;
                      const credit = linkedCredit[key] ?? line.landedCost;
                      return (
                        <Table.Tr key={key}>
                          <Table.Td>{String(line.product.name_en)}</Table.Td>
                          <Table.Td ta="end">{line.received / 1000}</Table.Td>
                          <Table.Td ta="end">{line.returned / 1000}</Table.Td>
                          <Table.Td w={144}>
                            <QtyInput
                              label={`${t('office.suppliers.return_qty')} ${String(line.product.name_en)}`}
                              unit={String(line.product.unit ?? 'pc') as never}
                              value={qty || null}
                              onChange={(value) =>
                                setLinkedQty((current) => ({
                                  ...current,
                                  [key]: Math.min(value ?? 0, line.remaining),
                                }))
                              }
                            />
                            {line.remaining === 0 ? (
                              <Text size="sm" c="dimmed">
                                {t('office.suppliers.return_none_left')}
                              </Text>
                            ) : null}
                          </Table.Td>
                          {can('cost.view') ? (
                            <Table.Td w={144}>
                              <MoneyInput
                                label={t('office.suppliers.credit_unit')}
                                value={credit}
                                onChange={(value) =>
                                  setLinkedCredit((current) => ({
                                    ...current,
                                    [key]: value ?? 0,
                                  }))
                                }
                              />
                            </Table.Td>
                          ) : null}
                          <Table.Td ta="end">
                            <MoneyText paisa={mulDivRound(qty, credit, 1000)} />
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Box>
            </Stack>
          </Paper>
        ) : (
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <TextInput
                label={t('office.suppliers.add_product')}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t('office.suppliers.search_product')}
              />
              {matches.length > 0 ? (
                <Group gap="xs">
                  {matches.map((product) => (
                    <Button
                      key={product.id}
                      type="button"
                      variant="default"
                      size="compact-sm"
                      onClick={() => addProduct(product.id)}
                    >
                      {String(product.name_en)} · {String(product.sku)}
                    </Button>
                  ))}
                </Group>
              ) : null}
              {unlinked.length > 0 ? (
                <Stack gap="sm">
                  {unlinked.map((line) => (
                    <Paper key={line.key} withBorder p="sm">
                      <Stack gap="sm">
                        <Text fw={500} className="ltr-name">
                          {line.name}
                        </Text>
                        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm">
                          <QtyInput
                            label={`${t('office.suppliers.return_qty')} ${line.name}`}
                            unit="pc"
                            value={line.qtyMilli}
                            onChange={(value) =>
                              setUnlinked((current) =>
                                current.map((row) =>
                                  row.key === line.key
                                    ? { ...row, qtyMilli: value ?? 0 }
                                    : row,
                                ),
                              )
                            }
                          />
                          {can('cost.view') ? (
                            <MoneyInput
                              label={t('office.suppliers.credit_unit')}
                              value={line.unitCredit}
                              onChange={(value) =>
                                setUnlinked((current) =>
                                  current.map((row) =>
                                    row.key === line.key
                                      ? { ...row, unitCredit: value ?? 0 }
                                      : row,
                                  ),
                                )
                              }
                            />
                          ) : null}
                          <Text size="sm" ta="end" style={{ alignSelf: 'end' }}>
                            <MoneyText
                              paisa={mulDivRound(
                                line.qtyMilli,
                                line.unitCredit,
                                1000,
                              )}
                            />
                          </Text>
                        </SimpleGrid>
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              ) : null}
            </Stack>
          </Paper>
        )}

        <Box component="fieldset" style={{ border: 0, margin: 0, padding: 0 }}>
          <Paper withBorder p="sm">
            <Text component="legend" size="sm" mb="xs">
              {t('office.suppliers.return_reason')}
            </Text>
            <Group gap="xs">
              {REASONS.map((key) => (
                <Button
                  key={key}
                  type="button"
                  size="compact-sm"
                  variant={reasonKey === key ? 'light' : 'default'}
                  aria-pressed={reasonKey === key}
                  onClick={() => setReasonKey(key)}
                >
                  {t(`office.suppliers.return_reason_${key}`)}
                </Button>
              ))}
            </Group>
            {reasonKey === 'other' ? (
              <TextInput
                mt="xs"
                aria-label={t('office.suppliers.return_reason')}
                maxLength={120}
                value={reasonText}
                onChange={(event) => setReasonText(event.currentTarget.value)}
              />
            ) : null}
          </Paper>
        </Box>

        <Paper withBorder p="sm">
          <Group justify="space-between" gap="sm" align="baseline">
            <Text size="sm">{t('office.suppliers.return_total')}</Text>
            <Text fz={22} fw={600}>
              <MoneyText paisa={total} />
            </Text>
          </Group>
        </Paper>

        {suggested > 0 ? (
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Text size="sm">
                {t('office.suppliers.return_suggested', {
                  amount: formatShopMoney(suggested),
                })}
              </Text>
              <MoneyInput
                label={t('office.suppliers.return_received')}
                value={refundReceived}
                onChange={(value) => {
                  setRefundTouched(true);
                  setRefundReceived(value);
                }}
              />
              <Group gap="xs">
                {(['cash', 'bank_wallet'] as const).map((method) => (
                  <Button
                    key={method}
                    type="button"
                    size="compact-sm"
                    variant={refundMethod === method ? 'light' : 'default'}
                    aria-pressed={refundMethod === method}
                    onClick={() => setRefundMethod(method)}
                  >
                    {t(`payment.${method}`)}
                  </Button>
                ))}
              </Group>
            </Stack>
          </Paper>
        ) : null}

        <TextInput
          label={t('office.suppliers.note')}
          maxLength={200}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />

        <Group gap="sm">
          <Button
            type="button"
            disabled={!canSave}
            loading={pending}
            onClick={() => void save()}
          >
            {t('office.suppliers.return_save')}
          </Button>
          <Link
            to="/suppliers/$supplierId"
            params={{ supplierId }}
            style={{ textDecoration: 'none' }}
          >
            <Button component="span" variant="default">
              {t('common.cancel')}
            </Button>
          </Link>
        </Group>
        {refundReceived !== null && refundReceived > 0 ? (
          <Text size="sm" c="dimmed">
            {t('office.suppliers.return_refund_hint')}
          </Text>
        ) : null}
      </Stack>
    </Box>
  );
}
