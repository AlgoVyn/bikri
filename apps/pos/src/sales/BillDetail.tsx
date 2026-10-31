import { businessDate, newId, saleLineFinal } from '@bikri/core';
import {
  ActionIcon,
  Box,
  Button,
  Group,
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
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageLoading } from '../components/PageLoading';
import { StatusPill } from '../components/StatusPill.tsx';
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
import { formatTimestamp } from '../lib/date';
import { formatShopMoney } from '../lib/money';
import { Modal } from '../sell/Modal.tsx';
import { useSellStore } from '../sell/sellStore.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { ApprovalDialog } from './ApprovalDialog.tsx';
import {
  METHOD_KEYS,
  type ReasonKey,
  statusLabel,
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
  if (!data) return <PageLoading compact />;
  if (
    !can('report.view') &&
    String(data.detail.sale.business_date) !== data.today
  ) {
    return <p className="p-4 text-text-muted">{t('shell.no_access')}</p>;
  }

  const { detail, timeZone } = data;
  const sale = detail.sale;
  const status = String(sale.status);
  const inclusive = sale.tax_inclusive === 1;
  const voidReason =
    detail.voidRow?.reason !== undefined ? String(detail.voidRow.reason) : '';
  const fullDate = formatTimestamp(
    Number(sale.created_at),
    i18n.language,
    timeZone,
  );

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
      ? t('office.void.summary_paid', { amount: formatShopMoney(paidBack) })
      : null,
    returnQty > 0
      ? t('office.void.summary_stock', { qty: returnQty / 1000 })
      : null,
    Number(sale.udhaar_amount) > 0
      ? t('office.void.summary_khata', {
          amount: formatShopMoney(Number(sale.udhaar_amount)),
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
    <Box
      p={embedded ? undefined : 'md'}
      mx={embedded ? undefined : 'auto'}
      maw={embedded ? undefined : 896}
      w="100%"
    >
      <Stack gap="sm">
        <Group gap="sm" wrap="nowrap">
          {embedded ? (
            <ActionIcon
              component={Link}
              to="/sales"
              variant="default"
              size={44}
              aria-label={t('office.bill.back')}
              title={t('office.bill.back')}
            >
              <span aria-hidden="true" className="rtl:rotate-180">
                ‹
              </span>
            </ActionIcon>
          ) : (
            <Button component={Link} to="/sales" variant="default">
              {t('office.bill.back')}
            </Button>
          )}
          <Title
            order={1}
            ff="monospace"
            fz="h2"
            style={{ marginInlineEnd: 'auto' }}
          >
            {String(sale.invoice_no)}
          </Title>
          <StatusPill
            testId="bill-status"
            label={statusLabel(t, status)}
            tone={
              status === 'paid'
                ? 'success'
                : status === 'part_refunded'
                  ? 'warning'
                  : status === 'void'
                    ? 'danger'
                    : 'gray'
            }
          />
        </Group>

        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
          <Button variant="default" onClick={() => void print()}>
            {t('office.bill.print')}
          </Button>
          <Button variant="default" onClick={() => void share()}>
            {t('office.bill.share')}
          </Button>
          <Button variant="default" onClick={() => void pdf()}>
            {t('office.bill.pdf')}
          </Button>
          {canRefund ? (
            <Button
              onClick={() =>
                void navigate({
                  to: '/sales/$id/refund',
                  params: { id: saleId },
                })
              }
            >
              {t('office.bill.refund')}
            </Button>
          ) : null}
          {canVoid ? (
            <>
              <Button
                variant="outline"
                color="danger"
                onClick={() => askVoid('void')}
              >
                {t('office.bill.void')}
              </Button>
              <Button variant="default" onClick={() => askVoid('reissue')}>
                {t('office.bill.void_reissue')}
              </Button>
            </>
          ) : null}
          {role === 'owner' ? (
            <Button variant="default" onClick={() => setAuditOpen(true)}>
              {t('office.bill.audit')}
            </Button>
          ) : null}
        </SimpleGrid>

        {canVoid && blocker === 'same_day' ? (
          <Paper p="xs" bg="var(--mantine-color-warning-subtle)">
            <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
              {t('office.bill.void_same_day')}
            </Text>
          </Paper>
        ) : null}
        {detail.conflicts.length > 0 ? (
          <Paper
            p="sm"
            role="alert"
            data-testid="bill-conflict"
            bg="var(--mantine-color-warning-subtle)"
          >
            <Text fw={500} c="var(--mantine-color-warning-subtle-ink)">
              {t('office.bill.conflict_warning')}
            </Text>
            <Text size="sm" c="var(--mantine-color-warning-subtle-ink)">
              {t('office.bill.conflict_body')}
            </Text>
            <Link to="/settings/sync" className="bikri-link">
              {t('office.bill.conflict_link')}
            </Link>
          </Paper>
        ) : null}
        {detail.refunds.length > 0 && status !== 'refunded' ? (
          <Paper withBorder p="xs">
            <Text size="sm" c="dimmed">
              {t('office.bill.refund_the_rest')}
            </Text>
          </Paper>
        ) : null}
        {status === 'void' ? (
          <Paper
            p="sm"
            bg="var(--mantine-color-danger-subtle)"
            style={{ border: '2px solid var(--mantine-color-danger-6)' }}
          >
            <Text fw={600} c="var(--mantine-color-danger-subtle-ink)">
              {t('office.bill.voided_title')}
            </Text>
            <Text c="var(--mantine-color-danger-subtle-ink)">
              {t('office.bill.voided_body', { reason: voidReason })}
            </Text>
            {detail.replacementSaleId ? (
              <Link
                to="/sales/$id"
                params={{ id: detail.replacementSaleId }}
                className="bikri-link"
              >
                {t('office.bill.replaced_by', {
                  invoice: detail.replacementInvoiceNo ?? '',
                })}
              </Link>
            ) : null}
          </Paper>
        ) : null}
        {detail.replacedSaleId ? (
          <Text size="sm" c="dimmed">
            {t('office.bill.replaces', {
              invoice: detail.replacedInvoiceNo ?? '',
            })}{' '}
            <Link
              to="/sales/$id"
              params={{ id: detail.replacedSaleId }}
              className="bikri-link"
            >
              {detail.replacedInvoiceNo}
            </Link>
          </Text>
        ) : null}

        <Paper withBorder p="sm">
          <SimpleGrid
            component="dl"
            cols={{ base: 2, sm: 4 }}
            spacing="sm"
            m={0}
          >
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
                    className="bikri-link"
                  >
                    {String(detail.customer.name)}
                  </Link>
                ) : (
                  t('office.sales.walk_in')
                )
              }
            />
          </SimpleGrid>
        </Paper>

        <Paper withBorder>
          <Box
            tabIndex={0}
            role="region"
            aria-label={t('office.bill.items')}
            style={{ overflowX: 'auto' }}
          >
            <Table fz="sm" verticalSpacing="xs" miw={560}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('office.bill.col_name')}</Table.Th>
                  <Table.Th ta="end">{t('office.bill.col_qty')}</Table.Th>
                  <Table.Th ta="end" visibleFrom="sm">
                    {t('office.bill.col_price')}
                  </Table.Th>
                  <Table.Th ta="end" visibleFrom="sm">
                    {t('office.bill.col_discount')}
                  </Table.Th>
                  <Table.Th ta="end">{t('office.bill.col_total')}</Table.Th>
                  <Table.Th ta="end" visibleFrom="sm">
                    {t('office.bill.col_refunded')}
                  </Table.Th>
                  <Table.Th ta="end" visibleFrom="sm">
                    {t('office.bill.col_kept')}
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {detail.lines.map(
                  ({ line, refundedMilli, keptMilli, unit }) => {
                    const qty = Number(line.qty_milli);
                    return (
                      <Table.Tr key={line.id}>
                        <Table.Td>
                          <Text size="sm" className="ltr-name">
                            {String(line.name_snapshot)}
                          </Text>
                          <Text size="xs" c="dimmed" hiddenFrom="sm">
                            {t('office.bill.qty_price', {
                              qty: `${qty / 1000} ${t(`unit.${unit}`)}`,
                              price: formatShopMoney(Number(line.unit_price)),
                            })}
                          </Text>
                          <Text size="xs" c="dimmed" hiddenFrom="sm">
                            {refundedMilli > 0
                              ? `${t('office.bill.col_refunded')}: ${refundedMilli / 1000} · `
                              : ''}
                            {`${t('office.bill.col_kept')}: ${keptMilli / 1000}`}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="end" ff="monospace">
                          {qty / 1000} {t(`unit.${unit}`)}
                        </Table.Td>
                        <Table.Td ta="end" visibleFrom="sm">
                          <MoneyText paisa={Number(line.unit_price)} />
                        </Table.Td>
                        <Table.Td ta="end" visibleFrom="sm">
                          <MoneyText paisa={Number(line.discount ?? 0)} />
                        </Table.Td>
                        <Table.Td ta="end">
                          <MoneyText
                            paisa={saleLineFinal(
                              {
                                net: Number(line.net),
                                bill_discount_alloc: Number(
                                  line.bill_discount_alloc,
                                ),
                                tax_alloc: Number(line.tax_alloc),
                                rounding_alloc: Number(line.rounding_alloc),
                              },
                              inclusive,
                            )}
                          />
                        </Table.Td>
                        <Table.Td ta="end" visibleFrom="sm">
                          {refundedMilli > 0 ? refundedMilli / 1000 : '—'}
                        </Table.Td>
                        <Table.Td ta="end" visibleFrom="sm">
                          {keptMilli / 1000}
                        </Table.Td>
                      </Table.Tr>
                    );
                  },
                )}
              </Table.Tbody>
            </Table>
          </Box>
        </Paper>

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Paper withBorder p="sm">
            <Title order={2} fz="md" mb="xs">
              {t('office.bill.totals')}
            </Title>
            <Stack gap={4}>
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
            </Stack>
          </Paper>

          <Paper withBorder p="sm">
            <Title order={2} fz="md" mb="xs">
              {t('office.bill.payments')}
            </Title>
            {detail.payments.filter((p) => p.direction === 'in').length ===
            0 ? (
              <Text size="sm" c="dimmed">
                {t('office.bill.no_payments')}
              </Text>
            ) : (
              <Stack gap={4}>
                {detail.payments
                  .filter((p) => p.direction === 'in')
                  .map((p) => (
                    <Group
                      key={p.id}
                      justify="space-between"
                      gap="sm"
                      wrap="wrap"
                      align="flex-start"
                    >
                      <Box>
                        <Text size="sm">
                          {t(
                            METHOD_KEYS[
                              String(p.method) as keyof typeof METHOD_KEYS
                            ] ?? 'payment.cash',
                          )}
                        </Text>
                        {p.reference ? (
                          <Text size="sm" c="dimmed">
                            {String(p.reference)}
                          </Text>
                        ) : null}
                        {Number(p.cash_tendered ?? 0) > 0 ? (
                          <Text size="xs" c="dimmed">
                            {t('office.bill.tendered', {
                              amount: formatShopMoney(Number(p.cash_tendered)),
                            })}{' '}
                            ·{' '}
                            {t('office.bill.change', {
                              amount: formatShopMoney(
                                Number(p.change_given ?? 0),
                              ),
                            })}
                          </Text>
                        ) : null}
                      </Box>
                      <MoneyText paisa={Number(p.amount)} />
                    </Group>
                  ))}
              </Stack>
            )}
            {detail.payments.filter((p) => p.direction === 'out').length > 0 ? (
              <>
                <Text fw={500} size="sm" mt="sm" mb={4}>
                  {t('office.bill.money_out')}
                </Text>
                <Stack gap={4}>
                  {detail.payments
                    .filter((p) => p.direction === 'out')
                    .map((p) => (
                      <Group
                        key={p.id}
                        justify="space-between"
                        gap="sm"
                        wrap="wrap"
                      >
                        <Text size="sm">
                          {String(p.purpose) === 'void'
                            ? t('office.bill.void_money_out')
                            : t('office.bill.refund_money_out')}
                        </Text>
                        <MoneyText paisa={Number(p.amount)} />
                      </Group>
                    ))}
                </Stack>
              </>
            ) : null}
          </Paper>
        </SimpleGrid>

        {detail.refunds.length > 0 ? (
          <Paper withBorder p="sm">
            <Title order={2} fz="md" mb="xs">
              {t('office.bill.refunds')}
            </Title>
            <Stack gap="sm">
              {detail.refunds.map(({ refund, lines, staffName }) => (
                <Paper key={refund.id} withBorder p="sm">
                  <Group justify="space-between" gap="sm" wrap="wrap">
                    <Text size="sm">
                      {formatTimestamp(
                        Number(refund.created_at),
                        i18n.language,
                        timeZone,
                      )}
                      {staffName ? ` · ${staffName}` : ''}
                    </Text>
                    <Text size="sm" fw={500}>
                      <MoneyText paisa={Number(refund.amount)} />
                    </Text>
                  </Group>
                  <Text size="sm" c="dimmed">
                    {t('office.bill.refund_reason', {
                      reason: String(refund.reason),
                    })}
                  </Text>
                  <Box
                    component="ul"
                    my={4}
                    ps="md"
                    style={{ color: 'var(--mantine-color-dimmed)' }}
                  >
                    {lines.map((rl) => (
                      <Text component="li" size="sm" key={rl.id}>
                        {String(
                          detail.lines.find(
                            (l) => l.line.id === rl.sale_line_id,
                          )?.line.name_snapshot ?? '',
                        )}{' '}
                        × {Number(rl.qty_milli) / 1000}
                      </Text>
                    ))}
                  </Box>
                  {Number(refund.udhaar_part) > 0 ? (
                    <Text size="sm">
                      {t('office.bill.refund_khata', {
                        amount: formatShopMoney(Number(refund.udhaar_part)),
                      })}
                    </Text>
                  ) : null}
                  {refund.method ? (
                    <Text size="sm" c="dimmed">
                      {t(
                        METHOD_KEYS[
                          String(refund.method) as keyof typeof METHOD_KEYS
                        ] ?? 'payment.cash',
                      )}
                      {Number(refund.rounding) !== 0
                        ? ` · ${t('office.bill.refund_rounding', {
                            amount: formatShopMoney(Number(refund.rounding)),
                          })}`
                        : ''}
                    </Text>
                  ) : null}
                  <Button
                    variant="transparent"
                    size="compact-sm"
                    px={0}
                    mt={4}
                    onClick={() => {
                      void queueRefundPrint(getDb(), String(refund.id)).then(
                        () => toast.push(t('office.bill.print_queued')),
                      );
                    }}
                  >
                    {t('office.bill.print_refund')}
                  </Button>
                </Paper>
              ))}
            </Stack>
          </Paper>
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
      </Stack>
    </Box>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box component="div">
      <Text component="dt" size="sm" c="dimmed">
        {label}
      </Text>
      <Text component="dd" size="sm" m={0}>
        {value}
      </Text>
    </Box>
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
    <Box
      pt={strong ? 'xs' : undefined}
      style={
        strong
          ? { borderTop: '1px solid var(--mantine-color-default-border)' }
          : undefined
      }
    >
      <Group justify="space-between" gap="sm" wrap="wrap">
        <Text size="sm" fw={strong ? 600 : undefined}>
          {label}
        </Text>
        <Text size="sm" fw={strong ? 600 : undefined}>
          {value}
        </Text>
      </Group>
    </Box>
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
      <Stack gap="sm">
        <Text size="sm">{body}</Text>
        {summary.length > 0 ? (
          <Box component="ul" ps="md" my={0}>
            {summary.map((line) => (
              <Text component="li" size="sm" key={line}>
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
        <Box component="fieldset" style={{ border: 0, margin: 0, padding: 0 }}>
          <Text component="legend" size="sm" mb={4}>
            {t('office.void.reason')}
          </Text>
          <Group gap="xs">
            {reasons.map((r) => (
              <Button
                key={r}
                type="button"
                size="compact-sm"
                variant={reason === r ? 'light' : 'default'}
                aria-pressed={reason === r}
                onClick={() => setReason(r)}
              >
                {t(`office.void.reason_${r}`)}
              </Button>
            ))}
          </Group>
        </Box>
        {reason === 'other' ? (
          <TextInput
            label={t('office.void.reason_other_label')}
            maxLength={120}
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        ) : null}
        <Group justify="flex-end" gap="sm">
          <Button
            type="button"
            variant="default"
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            color="danger"
            disabled={label.length === 0 || label.length > 120}
            onClick={() => {
              onConfirm(label);
              setReason('');
              setText('');
            }}
          >
            {confirm}
          </Button>
        </Group>
      </Stack>
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
        <Text size="sm">{t('office.bill.audit_empty')}</Text>
      ) : (
        <Stack gap="sm">
          {audit
            .slice()
            .sort((a, b) => Number(b.created_at) - Number(a.created_at))
            .map((row) => (
              <Paper key={row.id} withBorder p="sm">
                <Group justify="space-between" gap="sm" wrap="wrap">
                  <Text size="sm" fw={500}>
                    {String(row.action)}
                  </Text>
                  <Text size="sm" c="dimmed">
                    {formatTimestamp(
                      Number(row.created_at),
                      i18n.language,
                      timeZone,
                    )}
                  </Text>
                </Group>
                {row.after_json ? (
                  <Text
                    component="pre"
                    size="xs"
                    c="dimmed"
                    mt={4}
                    style={{
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      margin: 0,
                    }}
                  >
                    {String(row.after_json)}
                  </Text>
                ) : null}
              </Paper>
            ))}
        </Stack>
      )}
    </Modal>
  );
}
