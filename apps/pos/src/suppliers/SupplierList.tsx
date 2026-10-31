import {
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/EmptyState.tsx';
import { SearchIcon, SuppliersIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { supplierList, suppliersCsv } from '../data/suppliers.ts';
import { downloadText } from '../lib/download.ts';
import { rememberListScroll } from '../lib/listScroll.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { dateText, supplierBalanceLabel } from './format.ts';
import { SupplierDialog } from './SupplierDialog.tsx';

/** Suppliers list (screens/13). */
export function SupplierList({
  embedded = false,
  detailOpen = false,
  selectedId,
}: {
  embedded?: boolean;
  detailOpen?: boolean;
  selectedId?: string;
} = {}) {
  const { t, i18n } = useTranslation();
  const { can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const [query, setQuery] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const data = useLiveQuery(async () => {
    const db = getDb();
    const tz = await shopTimeZone(db);
    return { ...(await supplierList(db, { query })), tz };
  }, [query]);

  useHotkey(plainKey('n'), () => setNewOpen(true), {
    enabled: can('purchase.create') && !readOnly,
  });

  return (
    <Box
      p={embedded ? undefined : 'md'}
      mx={embedded ? undefined : 'auto'}
      maw={embedded ? undefined : 1152}
      w="100%"
    >
      <Stack gap="sm">
        <PageHeader
          icon={<SuppliersIcon />}
          tone="bg-success-subtle text-success-subtle-ink"
          title={t('office.suppliers.title')}
          subtitle={t('office.suppliers.subtitle')}
          headingLevel={detailOpen ? 'h2' : 'h1'}
          actions={
            <>
              {can('export.data') ? (
                <Button
                  type="button"
                  variant="default"
                  disabled={!data || data.rows.length === 0}
                  onClick={() =>
                    data &&
                    downloadText(
                      'bikri-suppliers.csv',
                      suppliersCsv(data.rows, data.tz),
                    )
                  }
                >
                  {t('office.suppliers.export_csv')}
                </Button>
              ) : null}
              {can('purchase.create') ? (
                <Button
                  type="button"
                  disabled={readOnly}
                  onClick={() => setNewOpen(true)}
                >
                  {t('office.suppliers.new_supplier')}
                </Button>
              ) : null}
            </>
          }
        />

        {data ? (
          <Paper withBorder p="sm">
            <Group gap={6} align="baseline">
              <Text size="sm">{t('office.suppliers.total_owed')}:</Text>
              <Text fz={24} fw={600}>
                <MoneyText paisa={data.totalOwed} />
              </Text>
            </Group>
          </Paper>
        ) : null}

        <Box component="search">
          <Paper withBorder p="sm">
            <TextInput
              type="search"
              label={t('office.suppliers.search')}
              placeholder={t('office.suppliers.search_placeholder')}
              leftSection={<SearchIcon />}
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </Paper>
        </Box>

        {data && data.rows.length === 0 ? (
          <EmptyState
            icon={<SuppliersIcon />}
            message={
              query
                ? t('office.suppliers.no_match')
                : t('office.suppliers.no_suppliers')
            }
            actionLabel={
              can('purchase.create') && !readOnly
                ? t('office.suppliers.new_supplier')
                : undefined
            }
            onAction={
              can('purchase.create') && !readOnly
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
              {data.rows.map((row, index) => (
                <Box
                  component="li"
                  key={row.supplier.id}
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
                    to="/suppliers/$supplierId"
                    params={{ supplierId: row.supplier.id }}
                    resetScroll={false}
                    onClick={rememberListScroll}
                    aria-current={
                      row.supplier.id === selectedId ? 'page' : undefined
                    }
                    className="bikri-list-link"
                  >
                    <Box style={{ flex: '2 1 10rem', minWidth: 0 }}>
                      <Text fw={500} truncate>
                        {String(row.supplier.name)}
                      </Text>
                      <Text size="sm" c="dimmed" dir="ltr">
                        {String(row.supplier.phone ?? '')}
                      </Text>
                    </Box>
                    <Text
                      size="sm"
                      fw={500}
                      style={{
                        flex: '1 1 9rem',
                        minWidth: 0,
                        whiteSpace: 'nowrap',
                      }}
                      c={
                        row.balance > 0
                          ? undefined
                          : row.balance < 0
                            ? 'var(--color-success)'
                            : 'dimmed'
                      }
                    >
                      {supplierBalanceLabel(t, row.balance)}
                    </Text>
                    <Text
                      size="sm"
                      c="dimmed"
                      style={{ flex: '1 1 9rem', minWidth: 0 }}
                    >
                      {row.lastDeliveryAt
                        ? t('office.suppliers.last_delivery', {
                            date: dateText(
                              new Date(row.lastDeliveryAt)
                                .toISOString()
                                .slice(0, 10),
                              i18n.language,
                              data.tz,
                            ),
                          })
                        : t('office.suppliers.never')}
                    </Text>
                  </Link>
                </Box>
              ))}
            </Box>
          </Paper>
        ) : null}

        <SupplierDialog open={newOpen} onOpenChange={setNewOpen} />
      </Stack>
    </Box>
  );
}
