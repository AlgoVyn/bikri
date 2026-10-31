import { businessDate } from '@bikri/core';
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageLoading } from '../components/PageLoading';
import { useToast } from '../components/Toast.tsx';
import { emptyCart } from '../data/cart.ts';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import {
  customerStatement,
  refreshPromises,
  reminderLink,
  reminderMessage,
  statementCsv,
} from '../data/udhaar.ts';
import { downloadText } from '../lib/download.ts';
import { downloadBlob } from '../print/receiptImage.ts';
import { useSellStore } from '../sell/sellStore.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { CustomerDialog } from './CustomerDialog.tsx';
import {
  ageLabel,
  balanceLabel,
  dateText,
  entryDescription,
  limitPercent,
} from './format.ts';
import { PromiseDialog } from './PromiseDialog.tsx';
import { ReceivePaymentDialog } from './ReceivePaymentDialog.tsx';
import { statementPdf, statementPng } from './statementFile.ts';

/** Customer khata statement (screens/12). */
export function CustomerStatement({
  customerId,
  embedded = false,
}: {
  customerId: string;
  embedded?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { can, role, staff } = useCurrentStaff();
  const readOnly = useReadOnly();
  const canEditPromises = can('party.edit');
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [promiseOpen, setPromiseOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canEditPromises) return;
    void (async () => {
      const db = getDb();
      const tz = await shopTimeZone(db);
      await refreshPromises(db, {
        today: businessDate(Date.now(), tz),
        actor: staff?.id ?? null,
      });
    })();
  }, [canEditPromises, staff?.id]);

  const data = useLiveQuery(async () => {
    const db = getDb();
    const customer = await db.customers.get(customerId);
    if (!customer) return null;
    const tz = await shopTimeZone(db);
    const today = businessDate(Date.now(), tz);
    const statement = await customerStatement(
      db,
      customerId,
      from || to
        ? { from: from || '0000-01-01', to: to || '9999-12-31' }
        : undefined,
    );
    const balance = (await db.party_balances.get(['customer', customerId]))
      ?.balance;
    const promise = (
      await db.promises.where('customer_id').equals(customerId).toArray()
    )
      .filter((p) => !p.deleted_at && p.status === 'open')
      .sort((a, b) =>
        String(a.promised_on).localeCompare(String(b.promised_on)),
      )[0];
    const shop = await db.shop.get('shop');
    return {
      customer,
      statement,
      tz,
      today,
      balance: balance ?? statement.balance,
      oldest: (await db.party_balances.get(['customer', customerId]))
        ?.oldest_unpaid_at,
      promise: promise ?? null,
      shopName: String(shop?.name ?? ''),
    };
  }, [customerId, from, to]);

  useHotkey(plainKey('r'), () => setReceiveOpen(true), {
    enabled: can('payment.receive') && !readOnly,
  });

  if (data === null)
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.udhaar.not_found')}
      </p>
    );
  if (!data) return <PageLoading compact />;

  const { customer, statement, tz, today, balance, shopName } = data;
  const phone = String(customer.phone ?? '');
  const name = String(customer.name);
  const reminder = reminderLink(
    phone,
    reminderMessage(i18n.language as 'en' | 'ur' | 'roman-ur', {
      name,
      shop: shopName,
      balance,
      date: dateText(today, i18n.language, tz),
    }),
  );
  const rows = statement.rows.map((row) => ({
    date: dateText(String(row.entry.business_date), i18n.language, tz),
    description: entryDescription(t, row),
    debit: row.debit,
    credit: row.credit,
    balance: row.balance,
  }));
  const meta = {
    shopName,
    customerName: name,
    phone,
    balance,
    from: from || null,
    to: to || null,
    rows,
    openingBalance: statement.openingBalance,
    labels: {
      title: t('office.udhaar.statement'),
      date: t('office.udhaar.date'),
      description: t('office.udhaar.description'),
      debit: t('office.udhaar.debit'),
      credit: t('office.udhaar.credit'),
      balance: t('office.udhaar.balance'),
      opening: t('office.udhaar.entry_opening'),
      total: t('office.udhaar.total'),
      asOf: t('office.udhaar.as_of', {
        date: dateText(today, i18n.language, tz),
      }),
    },
  };

  const exportCsv = () => {
    downloadText(
      `statement-${name.replace(/\s+/gu, '-')}.csv`,
      statementCsv(rows),
    );
  };
  const exportPdf = async () => {
    downloadBlob(
      await statementPdf(meta),
      `statement-${name.replace(/\s+/gu, '-')}.pdf`,
    );
  };
  const share = async () => {
    try {
      const png = await statementPng(meta);
      const file = new File([png], `statement-${name}.png`, {
        type: 'image/png',
      });
      // With a phone, hand the picture to WhatsApp the same way the reminder does.
      if (reminder) {
        downloadBlob(png, file.name);
        window.open(reminder, '_blank', 'noopener');
        toast.push(t('done.image_saved'));
      } else if (navigator.canShare?.({ files: [file] }))
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

  const sellTo = async () => {
    const db = getDb();
    const active = useSellStore.getState().active;
    const cart = (await db.carts.get(active)) ?? emptyCart(active);
    await db.carts.put({
      ...cart,
      customer_id: customerId,
      updated_at: Date.now(),
    });
    useSellStore.getState().setActive(active);
    void navigate({ to: '/sell' });
  };

  const percent = limitPercent(
    balance,
    customer.credit_limit === null || customer.credit_limit === undefined
      ? null
      : Number(customer.credit_limit),
  );

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
              to="/udhaar"
              variant="default"
              size={44}
              aria-label={t('office.udhaar.back_customers')}
              title={t('office.udhaar.back_customers')}
            >
              <span aria-hidden="true" className="rtl:rotate-180">
                ‹
              </span>
            </ActionIcon>
          ) : (
            <Button component={Link} to="/udhaar" variant="default">
              {t('office.udhaar.back_customers')}
            </Button>
          )}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Title order={1} fz="h2" style={{ overflowWrap: 'anywhere' }}>
              {name}
            </Title>
            {phone ? (
              <Anchor href={`tel:${phone}`} dir="ltr" size="sm">
                {phone}
              </Anchor>
            ) : null}
          </Box>
        </Group>
        <Text
          fz={32}
          fw={600}
          lh={1.15}
          c={balance > 0 ? undefined : balance < 0 ? 'teal' : 'dimmed'}
          data-testid="statement-balance"
        >
          {balanceLabel(t, balance)}
        </Text>

        <Group gap="sm">
          {can('payment.receive') ? (
            <Button
              type="button"
              disabled={readOnly}
              onClick={() => setReceiveOpen(true)}
            >
              {t('office.udhaar.receive_money')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="default"
            disabled={!reminder}
            title={reminder ? undefined : t('office.udhaar.reminder_no_phone')}
            onClick={() => {
              if (reminder) window.open(reminder, '_blank', 'noopener');
            }}
          >
            {t('office.udhaar.send_reminder')}
          </Button>
          {can('export.data') ? (
            <ExportMenu
              onCsv={exportCsv}
              onPdf={() => void exportPdf()}
              onShare={() => void share()}
            />
          ) : null}
          {can('party.edit') ? (
            <>
              <Button
                type="button"
                variant="default"
                disabled={readOnly}
                onClick={() => setPromiseOpen(true)}
              >
                {t('office.udhaar.add_promise')}
              </Button>
              {role !== 'cashier' ? (
                <Button
                  type="button"
                  variant="default"
                  disabled={readOnly}
                  onClick={() => setEditOpen(true)}
                >
                  {t('office.udhaar.edit')}
                </Button>
              ) : null}
            </>
          ) : null}
          {can('sale.create') ? (
            <Button
              type="button"
              variant="default"
              onClick={() => void sellTo()}
            >
              {t('office.udhaar.sell_to', { name })}
            </Button>
          ) : null}
        </Group>

        <Paper withBorder p="sm">
          <Group gap="md" align="center">
            <Text size="sm">
              {t('office.udhaar.limit')}:{' '}
              {customer.credit_limit === null ||
              customer.credit_limit === undefined ? (
                t('office.udhaar.no_limit')
              ) : (
                <MoneyText paisa={Number(customer.credit_limit)} />
              )}
            </Text>
            {percent !== null ? (
              <Box
                role="img"
                aria-label={t('office.udhaar.limit_bar', { percent })}
                w={160}
              >
                <Progress
                  value={percent}
                  size="sm"
                  color={
                    percent >= 100
                      ? 'danger'
                      : percent >= 80
                        ? 'warning'
                        : 'brand'
                  }
                />
              </Box>
            ) : null}
            <Text size="sm" c="dimmed">
              {ageLabel(t, data.oldest ?? null)}
            </Text>
            {data.promise ? (
              <Text size="sm" c="dimmed">
                {t('office.udhaar.promise_on', {
                  date: dateText(
                    String(data.promise.promised_on),
                    i18n.language,
                    tz,
                  ),
                })}
              </Text>
            ) : null}
          </Group>
        </Paper>

        <Group gap="sm" align="flex-end">
          <TextInput
            type="date"
            label={t('office.udhaar.from')}
            value={from}
            onChange={(event) => setFrom(event.currentTarget.value)}
            description={from ? dateText(from, i18n.language, tz) : undefined}
          />
          <TextInput
            type="date"
            label={t('office.udhaar.to')}
            value={to}
            onChange={(event) => setTo(event.currentTarget.value)}
            description={to ? dateText(to, i18n.language, tz) : undefined}
          />
          {from || to ? (
            <Button
              type="button"
              variant="default"
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              {t('office.udhaar.all_time')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="default"
            onClick={() =>
              tableRef.current?.scrollTo({
                top: tableRef.current.scrollHeight,
                behavior: 'smooth',
              })
            }
          >
            {t('office.udhaar.jump_latest')}
          </Button>
        </Group>

        <Stack gap="sm" hiddenFrom="sm">
          {statement.openingBalance !== 0 ? (
            <Paper withBorder p="sm">
              <Group justify="space-between" gap="sm">
                <Text size="sm">{t('office.udhaar.entry_opening')}</Text>
                <Text size="sm" fw={500}>
                  <MoneyText paisa={statement.openingBalance} />
                </Text>
              </Group>
            </Paper>
          ) : null}
          {rows.length === 0 ? (
            <Paper withBorder p="md">
              <Text size="sm" c="dimmed" ta="center">
                {t('office.udhaar.no_entries')}
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
                  {row.saleId ? (
                    <Link
                      to="/sales/$id"
                      params={{ id: row.saleId }}
                      className="bikri-link"
                    >
                      {rows[index]?.description}
                    </Link>
                  ) : (
                    rows[index]?.description
                  )}
                </Text>
                <SimpleGrid cols={2} spacing="sm" mt="xs">
                  <Box>
                    <Text size="sm" c="dimmed">
                      {t('office.udhaar.debit')}
                    </Text>
                    <Text size="sm" ta="end">
                      {row.debit > 0 ? <MoneyText paisa={row.debit} /> : '—'}
                    </Text>
                  </Box>
                  <Box>
                    <Text size="sm" c="dimmed">
                      {t('office.udhaar.credit')}
                    </Text>
                    <Text size="sm" ta="end">
                      {row.credit > 0 ? <MoneyText paisa={row.credit} /> : '—'}
                    </Text>
                  </Box>
                </SimpleGrid>
              </Paper>
            ))
          )}
        </Stack>

        <Paper withBorder visibleFrom="sm" style={{ overflow: 'hidden' }}>
          <Box
            ref={tableRef}
            tabIndex={0}
            role="region"
            aria-label={t('office.udhaar.statement')}
            style={{ maxHeight: '60vh', overflow: 'auto' }}
          >
            <Table fz="sm" miw={544} stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('office.udhaar.date')}</Table.Th>
                  <Table.Th>{t('office.udhaar.description')}</Table.Th>
                  <Table.Th ta="end">{t('office.udhaar.debit')}</Table.Th>
                  <Table.Th ta="end">{t('office.udhaar.credit')}</Table.Th>
                  <Table.Th ta="end">{t('office.udhaar.balance')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {statement.openingBalance !== 0 ? (
                  <Table.Tr>
                    <Table.Td />
                    <Table.Td>{t('office.udhaar.entry_opening')}</Table.Td>
                    <Table.Td />
                    <Table.Td />
                    <Table.Td ta="end">
                      <MoneyText paisa={statement.openingBalance} />
                    </Table.Td>
                  </Table.Tr>
                ) : null}
                {rows.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={5} ta="center" c="dimmed" py="md">
                      {t('office.udhaar.no_entries')}
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
                        {row.saleId ? (
                          <Link
                            to="/sales/$id"
                            params={{ id: row.saleId }}
                            className="bikri-link"
                          >
                            {rows[index]?.description}
                          </Link>
                        ) : (
                          rows[index]?.description
                        )}
                      </Table.Td>
                      <Table.Td ta="end">
                        {row.debit > 0 ? <MoneyText paisa={row.debit} /> : '—'}
                      </Table.Td>
                      <Table.Td ta="end">
                        {row.credit > 0 ? (
                          <MoneyText paisa={row.credit} />
                        ) : (
                          '—'
                        )}
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

        <Text size="sm" c="dimmed">
          {t('office.udhaar.balance')}: <MoneyText paisa={balance} /> ·{' '}
          {dateText(today, i18n.language, tz)}
        </Text>

        <ReceivePaymentDialog
          open={receiveOpen}
          onOpenChange={setReceiveOpen}
          customerId={customerId}
          customerName={name}
          balance={balance}
        />
        <PromiseDialog
          open={promiseOpen}
          onOpenChange={setPromiseOpen}
          customerId={customerId}
          customerName={name}
          balance={balance}
        />
        <CustomerDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          customer={customer}
        />
      </Stack>
    </Box>
  );
}
