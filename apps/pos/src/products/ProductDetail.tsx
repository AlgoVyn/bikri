import { formatQtyFromMilli, mulDivRound } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { useToast } from '../components/Toast.tsx';
import { addProduct, CartFullError } from '../data/cart.ts';
import {
  ledgerContext,
  ProductInUseError,
  productDetail,
  removeProduct,
  stockHistoryCsv,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { categoryName } from '../lib/category.ts';
import { formatTimestamp } from '../lib/date';
import { downloadText } from '../lib/download.ts';
import { formatShopMoney } from '../lib/money';
import { shortDate } from '../reports/format.ts';
import { useSellStore } from '../sell/sellStore.ts';
import { mutateCart, useShopMoney } from '../sell/useSell.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { AdjustDialog } from './AdjustDialog.tsx';
import { marginText, qtyWithUnit } from './format.ts';
import { ProductThumb } from './ProductThumb.tsx';

const LabelsDialog = lazy(() =>
  import('../labels/LabelsDialog.tsx').then((module) => ({
    default: module.LabelsDialog,
  })),
);

export function ProductDetailPage({
  id,
  adjust = false,
  embedded = false,
}: {
  id: string;
  /** `/products/:id/adjust` opens the stock adjust dialog (screens/09). */
  adjust?: boolean;
  embedded?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const detail = useLiveQuery(() => productDetail(getDb(), id), [id]);
  const readOnly = useReadOnly();
  const canEdit = can('catalog.edit') && !readOnly;
  const activeCart = useSellStore((state) => state.active);
  const money = useShopMoney();

  useHotkey(plainKey('l'), () => setLabelsOpen(true), {
    enabled: can('catalog.edit') || can('purchase.create'),
  });

  useHotkey(
    plainKey('e'),
    () => void navigate({ to: '/products/$id/edit', params: { id } }),
    {
      enabled: canEdit && Boolean(detail),
    },
  );

  if (detail === undefined) return null;
  if (detail === null) {
    return (
      <EmptyState
        heading={t('products.title')}
        message={t('products.not_found')}
      />
    );
  }
  const p = detail.product;
  const unit = String(p.unit ?? 'pc');
  const price = Number(p.price);
  const avg = Number(p.avg_cost ?? 0);
  const showCost = can('cost.view');
  const margin = marginText(price, avg);
  const maxQty = Math.max(1, ...detail.last14.map((d) => d.qty));
  const totalQty = detail.last14.reduce((s, d) => s + d.qty, 0);
  const totalRevenue = detail.last14.reduce((s, d) => s + d.revenue, 0);

  const addToSale = async () => {
    try {
      await mutateCart(activeCart, (cart) =>
        addProduct(cart, p, 1000, money.cost_method),
      );
      toast.push(t('pricecheck.added', { name: String(p.name_en) }), 'info');
      void navigate({ to: '/sell' });
    } catch (error) {
      if (error instanceof CartFullError)
        toast.push(t('sell.cart_full'), 'error');
      else throw error;
    }
  };

  const exportHistory = () => {
    downloadText(
      `stock-history-${String(p.sku)}.csv`,
      stockHistoryCsv(
        detail.history.map((h) => ({
          at: Number(h.movement.created_at),
          reason: String(h.movement.reason_code),
          qty: formatQtyFromMilli(Number(h.movement.qty_delta_milli), unit),
          balanceAfter: formatQtyFromMilli(h.balanceAfter, unit),
          by: h.staffName,
        })),
        'Asia/Karachi',
      ),
    );
  };

  return (
    <Box
      p={embedded ? undefined : 'md'}
      mx={embedded ? undefined : 'auto'}
      maw={embedded ? undefined : 1024}
      w="100%"
    >
      <Stack gap="md">
        {embedded ? (
          <Link
            to="/products"
            style={{ textDecoration: 'none', alignSelf: 'flex-start' }}
            className="xl:hidden"
          >
            <Button
              component="span"
              variant="default"
              leftSection={<span aria-hidden="true">‹</span>}
            >
              {t('products.back')}
            </Button>
          </Link>
        ) : null}
        <Group align="flex-start" gap="md" wrap="nowrap">
          <ProductThumb
            name={String(p.name_en)}
            imageKey={p.image_key}
            color={detail.category?.color}
            size="lg"
          />
          <Box style={{ minWidth: 0, flex: 1 }}>
            <Title
              order={1}
              fz="h2"
              className="ltr-name"
              style={{ overflowWrap: 'anywhere' }}
            >
              {String(p.name_en)}
            </Title>
            {p.name_ur ? (
              <Text lang="ur" dir="rtl" className="font-urdu">
                {String(p.name_ur)}
              </Text>
            ) : null}
            <Text c="dimmed">
              {[p.brand, categoryName(detail.category, i18n.language)]
                .filter(Boolean)
                .map(String)
                .join(' · ')}
            </Text>
            <Group gap="md" mt={4}>
              <Group gap={4}>
                <Text size="sm" c="dimmed">
                  {t('products.sku')}
                </Text>
                <Text size="sm" ff="monospace" component="bdi" dir="ltr">
                  {String(p.sku)}
                </Text>
              </Group>
              {detail.barcodes.length > 0 ? (
                <Group gap={4}>
                  <Text size="sm" c="dimmed">
                    {t('products.barcodes')}
                  </Text>
                  <Text size="sm" ff="monospace" component="bdi" dir="ltr">
                    {detail.barcodes.map((b) => String(b.barcode)).join(', ')}
                  </Text>
                </Group>
              ) : null}
            </Group>
          </Box>
        </Group>

        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
          {can('sale.create') && !readOnly ? (
            <Button
              type="button"
              variant="default"
              onClick={() => void addToSale()}
            >
              {t('products.sell')}
            </Button>
          ) : null}
          {canEdit ? (
            <Link
              to="/products/$id/edit"
              params={{ id }}
              style={{ textDecoration: 'none' }}
            >
              <Button component="span" fullWidth>
                {t('products.edit')}
              </Button>
            </Link>
          ) : null}
          {can('catalog.edit') || can('purchase.create') ? (
            <Button
              type="button"
              variant="default"
              onClick={() => setLabelsOpen(true)}
            >
              {t('products.print_label')}
            </Button>
          ) : null}
          {canEdit ? (
            <Link
              to="/products/new"
              search={{ duplicate: id }}
              style={{ textDecoration: 'none' }}
            >
              <Button component="span" variant="default" fullWidth>
                {t('products.duplicate')}
              </Button>
            </Link>
          ) : null}
          {p.track_stock === 1 && can('stock.adjust') && !readOnly ? (
            <Link
              to="/products/$id/adjust"
              params={{ id }}
              style={{ textDecoration: 'none' }}
            >
              <Button component="span" variant="default" fullWidth>
                {t('adjust.button')}
              </Button>
            </Link>
          ) : null}
          {can('catalog.delete') && !readOnly ? (
            <Button
              type="button"
              variant="outline"
              color="danger"
              onClick={() => setConfirmDelete(true)}
            >
              {t('products.delete')}
            </Button>
          ) : null}
        </SimpleGrid>

        <Box component="section" aria-label={t('products.price')}>
          <SimpleGrid cols={{ base: 2, sm: 3, xl: 4 }} spacing="sm">
            <Figure label={t('products.price')} testId="detail-price">
              <MoneyText paisa={price} />
            </Figure>
            {showCost ? (
              <>
                <Figure label={t('products.avg_cost')} testId="detail-avg-cost">
                  <MoneyText paisa={avg} />
                </Figure>
                <Figure
                  label={t('products.last_cost')}
                  testId="detail-last-cost"
                >
                  <MoneyText paisa={Number(p.last_cost ?? 0)} />
                </Figure>
                <Figure
                  label={t('products.profit_per_item')}
                  testId="detail-profit"
                >
                  {avg > 0 ? <MoneyText paisa={price - avg} /> : '—'}
                </Figure>
                <Figure label={t('products.margin')} testId="detail-margin">
                  <bdi dir="ltr">{margin ?? '—'}</bdi>
                </Figure>
              </>
            ) : null}
            {p.track_stock === 1 ? (
              <>
                <Figure label={t('products.on_hand')} testId="detail-on-hand">
                  {qtyWithUnit(t, detail.onHand, unit)}
                </Figure>
                <Figure label={t('products.min_stock')} testId="detail-min">
                  {Number(p.min_stock_milli ?? 0) > 0
                    ? qtyWithUnit(t, Number(p.min_stock_milli), unit)
                    : t('products.min_stock_off')}
                </Figure>
                {showCost ? (
                  <Figure
                    label={t('products.stock_value')}
                    testId="detail-stock-value"
                  >
                    <MoneyText
                      paisa={mulDivRound(Math.max(detail.onHand, 0), avg, 1000)}
                    />
                  </Figure>
                ) : null}
              </>
            ) : null}
          </SimpleGrid>
        </Box>

        <Paper withBorder p="lg">
          <Box component="section" aria-labelledby="last14-heading">
            <Title order={2} fz="lg" id="last14-heading">
              {t('products.last14')}
            </Title>
            <Text size="sm" c="dimmed">
              {t('products.last14_total', {
                qty: qtyWithUnit(t, totalQty, unit),
                amount: formatShopMoney(totalRevenue),
              })}
            </Text>
            {totalQty === 0 ? (
              <Text size="sm" c="dimmed" mt="sm">
                {t('products.last14_empty')}
              </Text>
            ) : (
              <Stack gap={4} mt="sm">
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 4,
                    height: 96,
                  }}
                  dir="ltr"
                  role="img"
                  aria-label={detail.last14
                    .map(
                      (d) =>
                        `${shortDate(d.date, i18n.language)}: ${formatQtyFromMilli(d.qty, unit)}`,
                    )
                    .join('; ')}
                >
                  {detail.last14.map((d) => (
                    <Box
                      key={d.date}
                      title={`${shortDate(d.date, i18n.language)}: ${formatQtyFromMilli(d.qty, unit)}`}
                      style={{
                        flex: 1,
                        borderRadius: '4px 4px 0 0',
                        background: 'var(--mantine-color-brand-6)',
                        height: `${Math.max(2, (d.qty / maxQty) * 100)}%`,
                        opacity: d.qty > 0 ? 1 : 0.25,
                      }}
                    />
                  ))}
                </Box>
                <Group justify="space-between" gap="sm" dir="ltr">
                  {[detail.last14[0], detail.last14.at(-1)]
                    .filter((d): d is NonNullable<typeof d> => d !== undefined)
                    .map((d) => (
                      <Text key={d.date} size="sm" c="dimmed">
                        {shortDate(d.date, i18n.language)}
                      </Text>
                    ))}
                </Group>
              </Stack>
            )}
          </Box>
        </Paper>

        <Box component="section" aria-labelledby="history-heading">
          <Stack gap="sm">
            <Group gap="sm">
              <Title
                order={2}
                fz="lg"
                id="history-heading"
                style={{ marginInlineEnd: 'auto' }}
              >
                {t('products.history')}
              </Title>
              {detail.history.length > 0 ? (
                <Button type="button" variant="default" onClick={exportHistory}>
                  {t('products.export_csv')}
                </Button>
              ) : null}
            </Group>
            {detail.history.length === 0 ? (
              <Text c="dimmed">{t('products.history_empty')}</Text>
            ) : (
              <Paper withBorder>
                <Box
                  tabIndex={0}
                  role="region"
                  aria-label={t('products.history')}
                  style={{ overflowX: 'auto' }}
                >
                  <Table fz="sm" miw={640}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('products.history_when')}</Table.Th>
                        <Table.Th>{t('products.history_reason')}</Table.Th>
                        <Table.Th ta="end">
                          {t('products.history_qty')}
                        </Table.Th>
                        <Table.Th ta="end">
                          {t('products.history_balance')}
                        </Table.Th>
                        <Table.Th visibleFrom="sm">
                          {t('products.history_by')}
                        </Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {detail.history.map((h) => {
                        const delta = Number(h.movement.qty_delta_milli);
                        return (
                          <Table.Tr key={h.movement.id}>
                            <Table.Td>
                              <Text size="sm" component="bdi" dir="ltr">
                                {formatTimestamp(
                                  Number(h.movement.created_at),
                                  i18n.language,
                                )}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              {t(
                                `stock.reason.${String(h.movement.reason_code)}`,
                              )}
                            </Table.Td>
                            <Table.Td ta="end">
                              <Text
                                size="sm"
                                component="bdi"
                                dir="ltr"
                                c={
                                  delta < 0
                                    ? 'var(--color-danger)'
                                    : 'var(--color-success)'
                                }
                              >
                                {delta > 0 ? '+' : '−'}
                                {formatQtyFromMilli(Math.abs(delta), unit)}
                              </Text>
                            </Table.Td>
                            <Table.Td ta="end" data-testid="history-balance">
                              <Text size="sm" component="bdi" dir="ltr">
                                {formatQtyFromMilli(h.balanceAfter, unit)}
                              </Text>
                            </Table.Td>
                            <Table.Td visibleFrom="sm">{h.staffName}</Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Box>
              </Paper>
            )}
          </Stack>
        </Box>

        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t('products.delete_title', { name: String(p.name_en) })}
          body={t('products.delete_body')}
          confirmLabel={t('products.delete')}
          onConfirm={async () => {
            try {
              await removeProduct(
                getDb(),
                id,
                await ledgerContext(getDb(), String(staff?.id ?? '')),
              );
              toast.push(t('products.deleted'));
              void navigate({ to: '/products' });
            } catch (error) {
              if (error instanceof ProductInUseError)
                toast.push(t('products.in_use'), 'error');
              else throw error;
            }
          }}
        />
        {labelsOpen ? (
          <Suspense fallback={null}>
            <LabelsDialog
              open={labelsOpen}
              onOpenChange={setLabelsOpen}
              initial={[{ productId: p.id, copies: 1 }]}
            />
          </Suspense>
        ) : null}
        {adjust && p.track_stock === 1 && can('stock.adjust') ? (
          <AdjustDialog
            product={p}
            onHand={detail.onHand}
            open
            onClose={() =>
              void navigate({ to: '/products/$id', params: { id } })
            }
          />
        ) : null}
      </Stack>
    </Box>
  );
}

function Figure({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Paper withBorder p="sm" h="100%" data-testid={testId}>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fz={20} fw={600} mt={4}>
        {children}
      </Text>
    </Paper>
  );
}
