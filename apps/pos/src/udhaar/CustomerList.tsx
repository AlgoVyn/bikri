import { businessDate } from '@bikri/core';
import {
  Box,
  Button,
  Grid,
  Group,
  NativeSelect,
  Paper,
  Progress,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/EmptyState.tsx';
import { SearchIcon, UdhaarIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import {
  type CustomerFilter,
  type CustomerSort,
  customerList,
  customersCsv,
  refreshPromises,
} from '../data/udhaar.ts';
import { downloadText } from '../lib/download.ts';
import { rememberListScroll } from '../lib/listScroll.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { CustomerDialog } from './CustomerDialog.tsx';
import { ageLabel, balanceLabel, limitPercent } from './format.ts';

/** Customers list (screens/12). */
export function UdhaarList({
  initialFilter = 'all',
  embedded = false,
  detailOpen = false,
  selectedId,
}: {
  initialFilter?: CustomerFilter;
  embedded?: boolean;
  detailOpen?: boolean;
  selectedId?: string;
}) {
  const { t } = useTranslation();
  const { can, staff } = useCurrentStaff();
  const readOnly = useReadOnly();
  const canEditPromises = can('party.edit');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CustomerFilter>(initialFilter);
  const [sort, setSort] = useState<CustomerSort>('balance');
  const [newOpen, setNewOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

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
    return {
      ...(await customerList(db, { query, filter, sort, today })),
      tz,
    };
  }, [query, filter, sort]);

  useHotkey(plainKey('n'), () => setNewOpen(true), {
    enabled: can('party.edit') && !readOnly,
  });

  const activeFilterCount =
    (filter === 'all' ? 0 : 1) + (sort === 'balance' ? 0 : 1);
  const filters: CustomerFilter[] = [
    'all',
    'owes',
    'over_limit',
    'in_credit',
    'promise_due',
  ];
  const sorts: CustomerSort[] = ['balance', 'oldest', 'name', 'activity'];

  return (
    <Box
      p={embedded ? undefined : 'md'}
      mx={embedded ? undefined : 'auto'}
      maw={embedded ? undefined : 1152}
      w="100%"
    >
      <Stack gap="sm">
        <PageHeader
          icon={<UdhaarIcon />}
          tone="bg-warning-subtle text-warning-subtle-ink"
          title={t('office.udhaar.title')}
          subtitle={t('office.udhaar.subtitle')}
          headingLevel={detailOpen ? 'h2' : 'h1'}
          actions={
            <>
              <Button component={Link} to="/udhaar/chase" variant="default">
                {t('office.udhaar.chase_list')}
              </Button>
              {can('export.data') ? (
                <Button
                  type="button"
                  variant="default"
                  disabled={!data || data.rows.length === 0}
                  onClick={() =>
                    data &&
                    downloadText(
                      'bikri-udhaar.csv',
                      customersCsv(data.rows, data.tz),
                    )
                  }
                >
                  {t('office.udhaar.export_csv')}
                </Button>
              ) : null}
              {can('party.edit') ? (
                <Button
                  type="button"
                  disabled={readOnly}
                  onClick={() => setNewOpen(true)}
                >
                  {t('office.udhaar.new_customer')}
                </Button>
              ) : null}
            </>
          }
        />

        {data ? (
          <Grid gap="sm">
            <Grid.Col span={{ base: 12, sm: 4 }}>
              <Card
                testid="udhaar-total"
                label={t('office.udhaar.total_owed')}
                value={<MoneyText paisa={data.totalOwed} />}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 4 }}>
              <Card
                testid="udhaar-owing"
                label={t('office.udhaar.customers_owing')}
                value={String(data.owingCount)}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 6, sm: 4 }}>
              <Card
                label={t('office.udhaar.received_this_month')}
                value={<MoneyText paisa={data.receivedThisMonth} />}
              />
            </Grid.Col>
          </Grid>
        ) : null}

        <Box component="search">
          <Paper withBorder p="sm">
            <Group align="flex-end" gap="sm">
              <TextInput
                type="search"
                label={t('office.udhaar.search')}
                placeholder={t('office.udhaar.search_placeholder')}
                leftSection={<SearchIcon />}
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                style={{ flex: '2 1 14rem', minWidth: 0 }}
              />
              <Button
                type="button"
                variant="default"
                hiddenFrom="sm"
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                {t('common.filters')}
                {activeFilterCount > 0 ? (
                  <Box
                    component="span"
                    ms={6}
                    px={6}
                    style={{
                      borderRadius: 999,
                      background: 'var(--mantine-color-brand-6)',
                      color: 'var(--mantine-color-white)',
                    }}
                  >
                    {activeFilterCount}
                  </Box>
                ) : null}
              </Button>
            </Group>
            <Group
              align="flex-end"
              gap="sm"
              mt="sm"
              display={filtersOpen ? undefined : { base: 'none', sm: 'flex' }}
            >
              <NativeSelect
                label={t('office.udhaar.filter')}
                value={filter}
                onChange={(event) =>
                  setFilter(event.currentTarget.value as CustomerFilter)
                }
                data={filters.map((value) => ({
                  value,
                  label: t(`office.udhaar.filter_${value}`),
                }))}
              />
              <NativeSelect
                label={t('office.udhaar.sort')}
                value={sort}
                onChange={(event) =>
                  setSort(event.currentTarget.value as CustomerSort)
                }
                data={sorts.map((value) => ({
                  value,
                  label: t(`office.udhaar.sort_${value}`),
                }))}
              />
            </Group>
          </Paper>
        </Box>

        {data && data.rows.length === 0 ? (
          <EmptyState
            icon={<UdhaarIcon />}
            message={
              query || filter !== 'all'
                ? t('office.udhaar.no_match')
                : t('office.udhaar.no_customers')
            }
            actionLabel={
              can('party.edit') && !readOnly
                ? t('office.udhaar.new_customer')
                : undefined
            }
            onAction={
              can('party.edit') && !readOnly
                ? () => setNewOpen(true)
                : undefined
            }
          />
        ) : null}

        {data && data.rows.length > 0 ? (
          <Paper withBorder p={0}>
            <Box
              component="ul"
              style={{ listStyle: 'none', margin: 0, padding: 0 }}
            >
              {data.rows.map((row, index) => {
                const percent = limitPercent(
                  row.balance,
                  row.customer.credit_limit === null ||
                    row.customer.credit_limit === undefined
                    ? null
                    : Number(row.customer.credit_limit),
                );
                return (
                  <Box
                    component="li"
                    key={row.customer.id}
                    style={
                      index > 0
                        ? {
                            borderTop:
                              '1px solid var(--mantine-color-default-border)',
                          }
                        : undefined
                    }
                  >
                    <Link
                      to="/udhaar/$customerId"
                      params={{ customerId: row.customer.id }}
                      resetScroll={false}
                      onClick={rememberListScroll}
                      aria-current={
                        row.customer.id === selectedId ? 'page' : undefined
                      }
                      className="bikri-list-link"
                    >
                      <Box style={{ flex: '2 1 10rem', minWidth: 0 }}>
                        <Text
                          fw={500}
                          lineClamp={2}
                          style={{ overflowWrap: 'anywhere' }}
                        >
                          {String(row.customer.name)}
                        </Text>
                        <Text size="sm" c="dimmed" dir="ltr">
                          {String(row.customer.phone ?? '')}
                        </Text>
                      </Box>
                      <Box style={{ flex: '1 1 8rem', minWidth: 0 }}>
                        <Text
                          size="sm"
                          fw={500}
                          c={
                            row.balance > 0
                              ? undefined
                              : row.balance < 0
                                ? 'teal'
                                : 'dimmed'
                          }
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {balanceLabel(t, row.balance)}
                        </Text>
                        <Text size="sm" c="dimmed">
                          {ageLabel(t, row.oldestUnpaidAt)}
                        </Text>
                      </Box>
                      <Box style={{ flex: '1 1 8rem', minWidth: 0 }}>
                        {percent !== null ? (
                          <>
                            <Box
                              role="img"
                              mb={4}
                              aria-label={t('office.udhaar.limit_bar', {
                                percent,
                              })}
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
                            <Text size="sm" c="dimmed">
                              <MoneyText paisa={row.balance} /> /{' '}
                              <MoneyText
                                paisa={Number(row.customer.credit_limit ?? 0)}
                              />
                            </Text>
                          </>
                        ) : null}
                      </Box>
                      <Text
                        size="sm"
                        c="dimmed"
                        style={{ flex: '1 1 8rem', minWidth: 0 }}
                      >
                        {row.promise
                          ? t('office.udhaar.promise_on', {
                              date: String(row.promise.promised_on),
                            })
                          : ''}
                      </Text>
                    </Link>
                  </Box>
                );
              })}
            </Box>
          </Paper>
        ) : null}

        <CustomerDialog open={newOpen} onOpenChange={setNewOpen} />
      </Stack>
    </Box>
  );
}

function Card({
  label,
  value,
  testid,
}: {
  label: string;
  value: ReactNode;
  testid?: string;
}) {
  return (
    <Paper withBorder p="sm" h="100%" data-testid={testid}>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fz={24} fw={600}>
        {value}
      </Text>
    </Paper>
  );
}
