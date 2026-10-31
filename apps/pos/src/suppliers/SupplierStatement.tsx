import { businessDate } from '@bikri/core';
import {
  ActionIcon,
  Anchor,
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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageLoading } from '../components/PageLoading';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import {
  supplierBalance,
  supplierStatement,
  supplierStatementCsv,
} from '../data/suppliers.ts';
import { downloadText } from '../lib/download.ts';
import { downloadBlob } from '../print/receiptImage.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { statementPdf, statementPng } from '../udhaar/statementFile.ts';
import {
  dateText,
  supplierBalanceLabel,
  supplierEntryDescription,
} from './format.ts';
import { PaySupplierDialog } from './PaySupplierDialog.tsx';
import { SupplierDialog } from './SupplierDialog.tsx';

/** Supplier detail / ledger (screens/13). */
export function SupplierStatement({
  supplierId,
  embedded = false,
}: {
  supplierId: string;
  embedded?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const [payOpen, setPayOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const data = useLiveQuery(async () => {
    const db = getDb();
    const supplier = await db.suppliers.get(supplierId);
    if (!supplier || supplier.deleted_at) return null;
    const tz = await shopTimeZone(db);
    const shop = await db.shop.get('shop');
    return {
      supplier,
      statement: await supplierStatement(db, supplierId),
      balance: await supplierBalance(db, supplierId),
      tz,
      shopName: String(shop?.name ?? ''),
    };
  }, [supplierId]);

  useHotkey(
    plainKey('d'),
    () =>
      void navigate({
        to: '/suppliers/$supplierId/delivery/new',
        params: { supplierId },
      }),
    { enabled: can('purchase.create') && !readOnly },
  );
  useHotkey(plainKey('p'), () => setPayOpen(true), {
    enabled: can('purchase.create') && !readOnly,
  });

  if (data === null)
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.suppliers.not_found')}
      </p>
    );
  if (!data) return <PageLoading compact />;

  const { supplier, statement, balance, tz, shopName } = data;
  const name = String(supplier.name);
  const rows = statement.rows.map((row) => ({
    date: dateText(String(row.entry.business_date), i18n.language, tz),
    description: supplierEntryDescription(t, row),
    got: row.got,
    paid: row.paid,
    balance: row.balance,
  }));
  const meta = {
    shopName,
    customerName: name,
    phone: String(supplier.phone ?? ''),
    balance,
    from: null,
    to: null,
    rows: rows.map((row) => ({
      date: row.date,
      description: row.description,
      debit: row.got,
      credit: row.paid,
      balance: row.balance,
    })),
    openingBalance: statement.openingBalance,
    labels: {
      title: t('office.suppliers.statement'),
      date: t('office.suppliers.date'),
      description: t('office.suppliers.description'),
      debit: t('office.suppliers.got'),
      credit: t('office.suppliers.paid'),
      balance: t('office.suppliers.balance'),
      opening: t('office.suppliers.entry_opening'),
      total: t('office.suppliers.total'),
      asOf: t('office.suppliers.as_of', {
        date: dateText(businessDate(Date.now(), tz), i18n.language, tz),
      }),
    },
  };
  const exportPdf = async () => {
    downloadBlob(
      await statementPdf(meta),
      `supplier-${name.replace(/\s+/gu, '-')}.pdf`,
    );
  };
  const share = async () => {
    try {
      const png = await statementPng(meta);
      const file = new File([png], `supplier-${name}.png`, {
        type: 'image/png',
      });
      if (navigator.canShare?.({ files: [file] }))
        await navigator.share({ files: [file], title: name });
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
    <Box
      p={embedded ? undefined : 'md'}
      mx={embedded ? undefined : 'auto'}
      maw={embedded ? undefined : 1024}
      w="100%"
    >
      <Stack gap="sm">
        <Group align="flex-start" gap="sm" wrap="nowrap">
          {embedded ? (
            <ActionIcon
              component={Link}
              to="/suppliers"
              variant="default"
              size={44}
              aria-label={t('office.suppliers.back')}
              title={t('office.suppliers.back')}
            >
              <span aria-hidden="true" className="rtl:rotate-180">
                ‹
              </span>
            </ActionIcon>
          ) : (
            <Button component={Link} to="/suppliers" variant="default">
              {t('office.suppliers.back')}
            </Button>
          )}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Title order={1} fz="h2" style={{ overflowWrap: 'anywhere' }}>
              {name}
            </Title>
            {supplier.phone ? (
              <Anchor
                href={`tel:${String(supplier.phone)}`}
                dir="ltr"
                size="sm"
              >
                {String(supplier.phone)}
              </Anchor>
            ) : null}
          </Box>
        </Group>
        <Text
          fz={32}
          fw={600}
          lh={1.15}
          c={
            balance > 0
              ? undefined
              : balance < 0
                ? 'var(--color-success)'
                : 'dimmed'
          }
          data-testid="supplier-balance"
        >
          {supplierBalanceLabel(t, balance)}
        </Text>

        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
          {can('purchase.create') ? (
            <>
              <Link
                to="/suppliers/$supplierId/delivery/new"
                params={{ supplierId }}
                aria-disabled={readOnly}
                onClick={(event) => {
                  if (readOnly) event.preventDefault();
                }}
                style={{
                  textDecoration: 'none',
                  opacity: readOnly ? 0.55 : undefined,
                }}
              >
                <Button component="span" fullWidth>
                  {t('office.suppliers.record_delivery')}
                </Button>
              </Link>
              <Button
                type="button"
                variant="default"
                disabled={readOnly}
                onClick={() => setPayOpen(true)}
              >
                {t('office.suppliers.pay_supplier')}
              </Button>
              <Link
                to="/suppliers/$supplierId/return/new"
                params={{ supplierId }}
                aria-disabled={readOnly}
                onClick={(event) => {
                  if (readOnly) event.preventDefault();
                }}
                style={{
                  textDecoration: 'none',
                  opacity: readOnly ? 0.55 : undefined,
                }}
              >
                <Button component="span" variant="default" fullWidth>
                  {t('office.suppliers.return_supplier')}
                </Button>
              </Link>
            </>
          ) : null}
          {can('purchase.create') ? (
            <Button
              type="button"
              variant="default"
              disabled={readOnly}
              onClick={() => setEditOpen(true)}
            >
              {t('office.suppliers.edit')}
            </Button>
          ) : null}
          {can('export.data') && rows.length > 0 ? (
            <ExportMenu
              onCsv={() =>
                downloadText(
                  `supplier-${name.replace(/\s+/gu, '-')}.csv`,
                  supplierStatementCsv(rows),
                )
              }
              onPdf={() => void exportPdf()}
              onShare={() => void share()}
            />
          ) : null}
        </SimpleGrid>

        <Stack gap="sm" hiddenFrom="sm">
          {rows.length === 0 ? (
            <Paper withBorder p="md">
              <Text size="sm" c="dimmed" ta="center">
                {t('office.suppliers.no_entries')}
              </Text>
            </Paper>
          ) : (
            statement.rows.map((row, index) => (
              <Paper withBorder p="sm" key={row.entry.id}>
                <Group justify="space-between" gap="sm" align="flex-start">
                  <Text size="sm" c="dimmed">
                    {dateText(
                      String(row.entry.business_date),
                      i18n.language,
                      tz,
                    )}
                  </Text>
                  <Text size="sm" fw={500}>
                    <MoneyText paisa={row.balance} />
                  </Text>
                </Group>
                <Text size="sm" mt={4}>
                  {rows[index]?.description}
                  {row.kind === 'purchase' &&
                  row.entry.source_id &&
                  can('purchase.create') &&
                  !readOnly ? (
                    <Link
                      to="/suppliers/$supplierId/return/new"
                      params={{ supplierId }}
                      search={{ purchase: String(row.entry.source_id) }}
                      className="bikri-link ms-2"
                    >
                      {t('office.suppliers.return_items')}
                    </Link>
                  ) : null}
                </Text>
                <SimpleGrid cols={2} spacing="sm" mt="xs">
                  <Box>
                    <Text size="sm" c="dimmed">
                      {t('office.suppliers.got')}
                    </Text>
                    <Text size="sm" ta="end">
                      {row.got > 0 ? <MoneyText paisa={row.got} /> : '—'}
                    </Text>
                  </Box>
                  <Box>
                    <Text size="sm" c="dimmed">
                      {t('office.suppliers.paid')}
                    </Text>
                    <Text size="sm" ta="end">
                      {row.paid > 0 ? <MoneyText paisa={row.paid} /> : '—'}
                    </Text>
                  </Box>
                </SimpleGrid>
              </Paper>
            ))
          )}
        </Stack>

        <Paper withBorder visibleFrom="sm">
          <Box
            tabIndex={0}
            role="region"
            aria-label={t('office.suppliers.statement')}
            style={{ overflow: 'auto' }}
          >
            <Table fz="sm" miw={512}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('office.suppliers.date')}</Table.Th>
                  <Table.Th>{t('office.suppliers.description')}</Table.Th>
                  <Table.Th ta="end">{t('office.suppliers.got')}</Table.Th>
                  <Table.Th ta="end">{t('office.suppliers.paid')}</Table.Th>
                  <Table.Th ta="end">{t('office.suppliers.balance')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={5} ta="center" c="dimmed" py="md">
                      {t('office.suppliers.no_entries')}
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  statement.rows.map((row, index) => (
                    <Table.Tr key={row.entry.id}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>
                        {dateText(
                          String(row.entry.business_date),
                          i18n.language,
                          tz,
                        )}
                      </Table.Td>
                      <Table.Td>
                        {rows[index]?.description}
                        {row.kind === 'purchase' &&
                        row.entry.source_id &&
                        can('purchase.create') &&
                        !readOnly ? (
                          <Link
                            to="/suppliers/$supplierId/return/new"
                            params={{ supplierId }}
                            search={{ purchase: String(row.entry.source_id) }}
                            className="bikri-link ms-2"
                          >
                            {t('office.suppliers.return_items')}
                          </Link>
                        ) : null}
                      </Table.Td>
                      <Table.Td ta="end">
                        {row.got > 0 ? <MoneyText paisa={row.got} /> : '—'}
                      </Table.Td>
                      <Table.Td ta="end">
                        {row.paid > 0 ? <MoneyText paisa={row.paid} /> : '—'}
                      </Table.Td>
                      <Table.Td ta="end" fw={500}>
                        <MoneyText paisa={row.balance} />
                      </Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
          </Box>
        </Paper>

        <PaySupplierDialog
          open={payOpen}
          onOpenChange={setPayOpen}
          supplierId={supplierId}
          supplierName={name}
          balance={balance}
        />
        <SupplierDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          supplier={supplier}
        />
      </Stack>
    </Box>
  );
}
