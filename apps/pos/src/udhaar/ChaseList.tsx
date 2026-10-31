import { businessDate } from '@bikri/core';
import { Box, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UdhaarIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import {
  type ChaseRow,
  chaseCsv,
  chaseList,
  refreshPromises,
  reminderLink,
  reminderMessage,
} from '../data/udhaar.ts';
import { downloadText } from '../lib/download.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { balanceLabel, dateText, groupLabel, timeText } from './format.ts';
import { PromiseDialog } from './PromiseDialog.tsx';
import { ReceivePaymentDialog } from './ReceivePaymentDialog.tsx';

/** Chase list (screens/12): promises due, then oldest unpaid age groups. */
export function ChaseList() {
  const { t, i18n } = useTranslation();
  const { can, staff } = useCurrentStaff();
  const canEditPromises = can('party.edit');
  const [selected, setSelected] = useState<ChaseRow | null>(null);
  const [dialog, setDialog] = useState<'promise' | 'receive' | null>(null);

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
    const tz = await shopTimeZone(db);
    const today = businessDate(Date.now(), tz);
    const shop = await db.shop.get('shop');
    return {
      ...(await chaseList(db, { today })),
      tz,
      today,
      shopName: String(shop?.name ?? ''),
    };
  }, []);

  const remind = (row: ChaseRow) => {
    if (!data) return;
    const link = reminderLink(
      String(row.customer.customer.phone ?? ''),
      reminderMessage(i18n.language as 'en' | 'ur' | 'roman-ur', {
        name: String(row.customer.customer.name),
        shop: data.shopName,
        balance: row.customer.balance,
        date: dateText(data.today, i18n.language, data.tz),
      }),
    );
    if (link) window.open(link, '_blank', 'noopener');
  };

  return (
    <Box mx="auto" maw={1024} p="md" w="100%">
      <Stack gap="md">
        <SubpageHeader
          backTo="/udhaar"
          backLabel={t('office.udhaar.back_customers')}
          icon={<UdhaarIcon />}
          title={t('office.udhaar.chase_title')}
          actions={
            can('export.data') && data ? (
              <Button
                type="button"
                variant="default"
                onClick={() =>
                  downloadText(
                    'bikri-chase.csv',
                    chaseCsv(data, (key) => groupLabel(t, key)),
                  )
                }
              >
                {t('office.udhaar.export_csv')}
              </Button>
            ) : null
          }
        />

        {data ? (
          <Paper withBorder p="sm" data-testid="chase-total">
            <Group gap={6} align="baseline">
              <Text size="sm">{t('office.udhaar.total_owed')}:</Text>
              <Text fz={22} fw={600}>
                <MoneyText paisa={data.total} />
              </Text>
            </Group>
          </Paper>
        ) : null}

        {data && data.groups.length === 0 ? (
          <Paper withBorder p="md">
            <Text c="dimmed" ta="center">
              {t('office.udhaar.no_chase')}
            </Text>
          </Paper>
        ) : null}

        {data?.groups.map((group) => (
          <Box component="section" key={group.key}>
            <Stack gap={4}>
              <Group
                justify="space-between"
                align="baseline"
                gap="sm"
                wrap="wrap"
                pb={4}
                style={{
                  borderBottom: '1px solid var(--mantine-color-default-border)',
                }}
              >
                <Title order={2} fz="md">
                  {groupLabel(t, group.key)}
                </Title>
                <Text size="sm" c="dimmed">
                  <MoneyText paisa={group.total} />
                </Text>
              </Group>
              <Paper withBorder>
                <Box
                  component="ul"
                  style={{ listStyle: 'none', margin: 0, padding: 0 }}
                >
                  {group.rows.map((row, index) => (
                    <Box
                      component="li"
                      key={row.customer.customer.id}
                      p="sm"
                      style={{
                        borderTop:
                          index > 0
                            ? '1px solid var(--mantine-color-default-border)'
                            : undefined,
                      }}
                    >
                      <Group gap="sm" wrap="wrap">
                        <Link
                          to="/udhaar/$customerId"
                          params={{ customerId: row.customer.customer.id }}
                          className="bikri-list-link"
                          style={{ flex: '2 1 12rem', padding: 0 }}
                        >
                          <Box style={{ minWidth: 0 }}>
                            <Text fw={500} truncate>
                              {String(row.customer.customer.name)}
                            </Text>
                            <Text size="sm" c="dimmed">
                              {t('office.udhaar.days_old', {
                                days: row.ageDays,
                              })}
                              {row.lastPaymentAt
                                ? ` · ${timeText(
                                    row.lastPaymentAt,
                                    i18n.language,
                                    data.tz,
                                  )}`
                                : ''}
                            </Text>
                          </Box>
                        </Link>
                        <Text
                          size="sm"
                          fw={500}
                          ta="end"
                          style={{ flex: '1 1 7rem', whiteSpace: 'nowrap' }}
                          c={
                            row.customer.balance > 0
                              ? undefined
                              : row.customer.balance < 0
                                ? 'var(--color-success)'
                                : 'dimmed'
                          }
                        >
                          {balanceLabel(t, row.customer.balance)}
                        </Text>
                        <Group gap="xs" wrap="wrap">
                          <Button
                            type="button"
                            variant="default"
                            size="compact-sm"
                            disabled={
                              !String(row.customer.customer.phone ?? '')
                            }
                            onClick={() => remind(row)}
                          >
                            {t('office.udhaar.remind')}
                          </Button>
                          {row.customer.customer.phone ? (
                            <Button
                              component="a"
                              href={`tel:${String(row.customer.customer.phone)}`}
                              variant="default"
                              size="compact-sm"
                            >
                              {t('office.udhaar.call')}
                            </Button>
                          ) : null}
                          {can('party.edit') ? (
                            <Button
                              type="button"
                              variant="default"
                              size="compact-sm"
                              onClick={() => {
                                setSelected(row);
                                setDialog('promise');
                              }}
                            >
                              {t('office.udhaar.promise')}
                            </Button>
                          ) : null}
                          {can('payment.receive') ? (
                            <Button
                              type="button"
                              size="compact-sm"
                              onClick={() => {
                                setSelected(row);
                                setDialog('receive');
                              }}
                            >
                              {t('office.udhaar.receive')}
                            </Button>
                          ) : null}
                        </Group>
                      </Group>
                    </Box>
                  ))}
                </Box>
              </Paper>
            </Stack>
          </Box>
        ))}

        {selected ? (
          <>
            <PromiseDialog
              open={dialog === 'promise'}
              onOpenChange={(open) => setDialog(open ? 'promise' : null)}
              customerId={selected.customer.customer.id}
              customerName={String(selected.customer.customer.name)}
              balance={selected.customer.balance}
            />
            <ReceivePaymentDialog
              open={dialog === 'receive'}
              onOpenChange={(open) => setDialog(open ? 'receive' : null)}
              customerId={selected.customer.customer.id}
              customerName={String(selected.customer.customer.name)}
              balance={selected.customer.balance}
            />
          </>
        ) : null}
      </Stack>
    </Box>
  );
}
