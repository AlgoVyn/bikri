import { businessDate, computePurchase, isQtyUnit, newId } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import {
  ActionIcon,
  Box,
  Button,
  Checkbox,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageLoading } from '../components/PageLoading';
import { QtyInput } from '../components/QtyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { DeliveryError, saveDelivery } from '../data/purchases.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { supplierBalance } from '../data/suppliers.ts';
import { formatBusinessDate } from '../lib/date';
import { formatShopMoney } from '../lib/money';
import { useCurrentStaff } from '../state/currentStaff.ts';

type Line = {
  key: string;
  product: MasterRow;
  qtyMilli: number;
  unitCost: number;
  updatePrice: boolean;
  price: number;
};

/** Record a delivery / purchase (screens/13). */
export function DeliveryPage({ supplierId }: { supplierId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [otherCharges, setOtherCharges] = useState<number | null>(null);
  const [paidNow, setPaidNow] = useState<number | null>(null);
  const [paidMethod, setPaidMethod] = useState<'cash' | 'bank_wallet' | 'card'>(
    'cash',
  );
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const purchaseId = useState(() => newId())[0];

  const data = useLiveQuery(async () => {
    const db = getDb();
    const supplier = await db.suppliers.get(supplierId);
    if (!supplier || supplier.deleted_at) return null;
    const tz = await shopTimeZone(db);
    const today = businessDate(Date.now(), tz);
    const products = (await db.products.toArray()).filter((p) => !p.deleted_at);
    const barcodes = await db.product_barcodes.toArray();
    return {
      supplier,
      tz,
      today,
      products,
      barcodes,
      balance: await supplierBalance(db, supplierId),
    };
  }, [supplierId]);

  const [date, setDate] = useState('');
  const today = data?.today ?? businessDate(Date.now());
  const chosenDate = date || today;
  const minDate = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  })();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return [];
    const barcode = data.barcodes.find(
      (b) => String(b.barcode) === q && !b.deleted_at,
    );
    return data.products
      .filter(
        (p) =>
          p.id === barcode?.product_id ||
          String(p.name_en).toLowerCase().includes(q) ||
          String(p.sku).toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [query, data]);

  const add = (product: MasterRow) => {
    setLines((current) => [
      ...current,
      {
        key: newId(),
        product,
        qtyMilli: 1000,
        unitCost: Number(product.last_cost || product.avg_cost || 0),
        updatePrice: false,
        price: Number(product.price ?? 0),
      },
    ]);
    setQuery('');
  };

  const valid = lines.filter((line) => line.qtyMilli > 0 && line.unitCost >= 0);
  const purchase =
    valid.length > 0
      ? computePurchase(
          valid.map((line) => ({
            qty_milli: line.qtyMilli,
            unit_cost: line.unitCost,
          })),
          otherCharges ?? 0,
        )
      : null;
  const total = purchase?.total ?? 0;
  const paid = paidNow ?? 0;

  const save = async () => {
    if (!data || pending || valid.length === 0) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      await saveDelivery(
        db,
        {
          purchaseId,
          supplierId,
          invoiceNo,
          date: chosenDate,
          lines: valid.map((line) => ({
            productId: line.product.id,
            qtyMilli: line.qtyMilli,
            unitCost: line.unitCost,
            updatePrice: line.updatePrice ? line.price : null,
          })),
          otherCharges: otherCharges ?? 0,
          paidNow: paid,
          paidMethod: paid > 0 ? paidMethod : null,
          note,
        },
        ctx,
        { today },
      );
      const after = await supplierBalance(db, supplierId);
      const labelRows = valid.map((line) => {
        const unit = String(line.product.unit ?? 'pc');
        const whole = ['pc', 'pair', 'set', 'box', 'pack', 'dozen'].includes(
          unit,
        );
        return {
          productId: line.product.id,
          copies: whole ? Math.max(1, Math.floor(line.qtyMilli / 1000)) : 1,
        };
      });
      sessionStorage.setItem(
        'bikri.label_seed',
        JSON.stringify({
          rows: labelRows,
          returnTo: `/suppliers/${supplierId}`,
        }),
      );
      toast.push(
        t('office.suppliers.delivery_saved', {
          count: valid.length,
          total: formatShopMoney(total),
          balance: formatShopMoney(after),
        }),
        'info',
        [
          {
            label: t('office.suppliers.print_labels'),
            onClick: () => void navigate({ to: '/labels' }),
          },
        ],
      );
      void navigate({
        to: '/suppliers/$supplierId',
        params: { supplierId },
      });
    } catch (err) {
      if (err instanceof DeliveryError)
        toast.push(t(`office.suppliers.delivery_error_${err.code}`), 'error');
      else toast.push(t('errors.generic'), 'error');
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
            aria-label={t('office.suppliers.back')}
            title={t('office.suppliers.back')}
            style={{ textDecoration: 'none' }}
          >
            <Button
              component="span"
              variant="default"
              leftSection={<span aria-hidden="true">‹</span>}
            >
              {t('common.back')}
            </Button>
          </Link>
          <Title order={1} fz="h2" style={{ marginInlineEnd: 'auto' }}>
            {t('office.suppliers.delivery_title')}
          </Title>
          <Text size="sm" c="dimmed">
            {String(data.supplier.name)} · {formatShopMoney(data.balance)}
          </Text>
        </Group>

        <Paper withBorder p="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label={t('office.suppliers.supplier_invoice')}
              maxLength={30}
              value={invoiceNo}
              onChange={(event) => setInvoiceNo(event.currentTarget.value)}
            />
            <TextInput
              type="date"
              label={t('office.suppliers.delivery_date')}
              min={minDate}
              max={today}
              value={chosenDate}
              onChange={(event) => setDate(event.currentTarget.value)}
              description={formatBusinessDate(chosenDate, i18n.language)}
            />
          </SimpleGrid>
        </Paper>

        <Paper withBorder p="sm">
          <Stack gap="sm">
            <Group justify="space-between" gap="sm">
              <Text size="sm" fw={500}>
                {t('office.suppliers.lines')}
              </Text>
              <Text
                size="sm"
                px="xs"
                py={2}
                bg="var(--mantine-color-default-hover)"
                style={{ borderRadius: 999 }}
                data-testid="delivery-line-count"
                aria-live="polite"
              >
                {t('office.suppliers.lines_count', { count: lines.length })}
              </Text>
            </Group>

            <Box component="search">
              <TextInput
                label={t('office.suppliers.add_product')}
                placeholder={t('office.suppliers.search_product')}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && matches[0]) {
                    event.preventDefault();
                    add(matches[0]);
                  }
                }}
              />
              {matches.length > 0 ? (
                <Paper withBorder mt="xs">
                  <Box
                    component="ul"
                    style={{ listStyle: 'none', margin: 0, padding: 0 }}
                  >
                    {matches.map((p, index) => (
                      <Box
                        component="li"
                        key={p.id}
                        style={
                          index > 0
                            ? {
                                borderTop:
                                  '1px solid var(--mantine-color-default-border)',
                              }
                            : undefined
                        }
                      >
                        <Button
                          type="button"
                          variant="transparent"
                          fullWidth
                          justify="flex-start"
                          onClick={() => add(p)}
                        >
                          <Group gap="sm" wrap="nowrap" w="100%">
                            <Text size="sm" fw={500} className="ltr-name">
                              {String(p.name_en)}
                            </Text>
                            <Text size="sm" c="dimmed">
                              {String(p.sku)}
                            </Text>
                            <Text size="sm" ms="auto">
                              <MoneyText
                                paisa={Number(p.last_cost || p.avg_cost || 0)}
                              />
                            </Text>
                          </Group>
                        </Button>
                      </Box>
                    ))}
                  </Box>
                </Paper>
              ) : null}
            </Box>

            {lines.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('office.suppliers.no_lines')}
              </Text>
            ) : (
              <Stack gap="sm">
                {lines.map((line, index) => {
                  const lineResult = purchase?.lines[valid.indexOf(line)];
                  const rawUnit = String(line.product.unit);
                  const unit = isQtyUnit(rawUnit) ? rawUnit : 'pc';
                  return (
                    <Paper
                      key={line.key}
                      withBorder
                      p="sm"
                      data-testid="delivery-line"
                    >
                      <Group align="flex-start" gap="sm" wrap="nowrap">
                        <Box style={{ flex: 1, minWidth: 0 }}>
                          <Text fw={500} style={{ overflowWrap: 'anywhere' }}>
                            {String(line.product.name_en)}
                          </Text>
                          <Text size="sm" c="dimmed">
                            {unit} · {t('office.suppliers.line_total')}:{' '}
                            <MoneyText paisa={lineResult?.line_total ?? 0} />
                          </Text>
                        </Box>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size={44}
                          aria-label={`${t('office.suppliers.remove')} ${String(line.product.name_en)}`}
                          title={`${t('office.suppliers.remove')} ${String(line.product.name_en)}`}
                          onClick={() =>
                            setLines((current) =>
                              current.filter((_, i) => i !== index),
                            )
                          }
                        >
                          <span aria-hidden="true">×</span>
                        </ActionIcon>
                      </Group>
                      <SimpleGrid
                        cols={{ base: 2, sm: 3 }}
                        spacing="sm"
                        mt="sm"
                      >
                        <Box
                          data-testid="delivery-line-qty"
                          style={{ gridColumn: 'span 2' }}
                        >
                          <QtyInput
                            label={t('office.suppliers.qty')}
                            unit={unit}
                            value={line.qtyMilli}
                            onChange={(milli) =>
                              setLines((current) =>
                                current.map((l, i) =>
                                  i === index
                                    ? { ...l, qtyMilli: milli ?? 0 }
                                    : l,
                                ),
                              )
                            }
                          />
                        </Box>
                        <MoneyInput
                          label={t('office.suppliers.unit_cost')}
                          value={line.unitCost}
                          onChange={(paisa) =>
                            setLines((current) =>
                              current.map((l, i) =>
                                i === index
                                  ? { ...l, unitCost: paisa ?? 0 }
                                  : l,
                              ),
                            )
                          }
                        />
                        <Box style={{ gridColumn: 'span 2' }}>
                          <Checkbox
                            label={t('office.suppliers.update_price')}
                            checked={line.updatePrice}
                            onChange={(event) =>
                              setLines((current) =>
                                current.map((l, i) =>
                                  i === index
                                    ? {
                                        ...l,
                                        updatePrice:
                                          event.currentTarget.checked,
                                      }
                                    : l,
                                ),
                              )
                            }
                          />
                          {line.updatePrice ? (
                            <Box mt="xs">
                              <MoneyInput
                                label={t('office.suppliers.price')}
                                value={line.price}
                                onChange={(paisa) =>
                                  setLines((current) =>
                                    current.map((l, i) =>
                                      i === index
                                        ? { ...l, price: paisa ?? 0 }
                                        : l,
                                    ),
                                  )
                                }
                              />
                            </Box>
                          ) : (
                            <Text size="sm" c="dimmed" mt={4}>
                              {t('office.suppliers.price')}:{' '}
                              <MoneyText
                                paisa={Number(line.product.price ?? 0)}
                              />
                            </Text>
                          )}
                        </Box>
                      </SimpleGrid>
                    </Paper>
                  );
                })}
              </Stack>
            )}

            <Group align="flex-end" gap="sm">
              <Box w={160}>
                <MoneyInput
                  label={t('office.suppliers.other_charges')}
                  value={otherCharges}
                  onChange={setOtherCharges}
                />
              </Box>
              <Group gap={6} align="baseline" ms="auto">
                <Text size="sm">{t('office.suppliers.total')}:</Text>
                <Text fz={22} fw={600}>
                  <MoneyText paisa={total} />
                </Text>
              </Group>
            </Group>
          </Stack>
        </Paper>

        <Paper withBorder p="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <MoneyInput
              label={t('office.suppliers.paid_now')}
              value={paidNow}
              onChange={setPaidNow}
            />
            <Box
              component="fieldset"
              style={{ border: 0, margin: 0, padding: 0 }}
            >
              <Text component="legend" size="sm" mb={4}>
                {t('office.suppliers.method')}
              </Text>
              <Group gap="xs">
                {(['cash', 'bank_wallet', 'card'] as const).map((m) => (
                  <Button
                    key={m}
                    type="button"
                    size="compact-sm"
                    variant={paidMethod === m ? 'light' : 'default'}
                    aria-pressed={paidMethod === m}
                    onClick={() => setPaidMethod(m)}
                  >
                    {t(`payment.${m}`)}
                  </Button>
                ))}
              </Group>
            </Box>
            <Box style={{ gridColumn: '1 / -1' }}>
              <TextInput
                label={t('office.suppliers.note')}
                maxLength={200}
                value={note}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
            </Box>
          </SimpleGrid>
        </Paper>

        <Group justify="flex-end" gap="sm">
          <Link
            to="/suppliers/$supplierId"
            params={{ supplierId }}
            style={{ textDecoration: 'none' }}
          >
            <Button component="span" variant="default">
              {t('common.cancel')}
            </Button>
          </Link>
          <Button
            type="button"
            disabled={valid.length === 0 || pending || paid > total}
            loading={pending}
            onClick={() => void save()}
          >
            {t('office.suppliers.save_delivery')}
          </Button>
        </Group>
        {paid > total ? (
          <Text size="sm" c="danger">
            {t('office.suppliers.delivery_error_paid')}
          </Text>
        ) : null}
      </Stack>
    </Box>
  );
}
