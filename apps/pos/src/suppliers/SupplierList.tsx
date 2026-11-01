import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { SearchIcon, SuppliersIcon } from '../components/icons.tsx';
import { ListSurface } from '../components/ListSurface.tsx';
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
import {
  dateText,
  supplierBalanceLabel,
  supplierBalanceTone,
} from './format.ts';
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
    <div
      className={
        embedded ? 'flex min-w-0 flex-col gap-3' : pageClass('standard')
      }
    >
      <PageHeader
        icon={<SuppliersIcon />}
        title={t('office.suppliers.title')}
        subtitle={t('office.suppliers.subtitle')}
        headingLevel={detailOpen ? 'h2' : 'h1'}
        actions={
          <>
            {can('export.data') ? (
              <button
                type="button"
                className={buttonQuiet}
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
              </button>
            ) : null}
            {can('purchase.create') ? (
              <button
                type="button"
                className={`${buttonPrimary} gap-2`}
                disabled={readOnly}
                onClick={() => setNewOpen(true)}
              >
                {t('office.suppliers.new_supplier')}
              </button>
            ) : null}
          </>
        }
      />

      <ListSurface
        toolbar={
          <search className="flex flex-col">
            <label className="flex min-w-0 flex-col">
              <span className="mb-1 text-small">
                {t('office.suppliers.search')}
              </span>
              <span className="flex h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-3">
                <SearchIcon />
                <input
                  type="search"
                  autoComplete="off"
                  className="min-w-0 flex-1 bg-transparent text-body outline-none"
                  placeholder={t('office.suppliers.search_placeholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </span>
            </label>
          </search>
        }
        summary={
          data ? (
            <p className="text-small">
              {t('office.suppliers.total_owed')}:{' '}
              <span className="text-title font-semibold">
                <MoneyText paisa={data.totalOwed} />
              </span>
            </p>
          ) : undefined
        }
      >
        {data && data.rows.length === 0 ? (
          <EmptyState
            variant="plain"
            icon={<SuppliersIcon />}
            message={
              query
                ? t('office.suppliers.no_match')
                : t('office.suppliers.no_suppliers')
            }
            actionLabel={
              query
                ? t('common.clear_filters')
                : can('purchase.create') && !readOnly
                  ? t('office.suppliers.new_supplier')
                  : undefined
            }
            onAction={
              query
                ? () => setQuery('')
                : can('purchase.create') && !readOnly
                  ? () => setNewOpen(true)
                  : undefined
            }
          />
        ) : null}

        {data && data.rows.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border">
            {data.rows.map((row) => (
              <li key={row.supplier.id}>
                <Link
                  to="/suppliers/$supplierId"
                  params={{ supplierId: row.supplier.id }}
                  resetScroll={false}
                  onClick={rememberListScroll}
                  aria-current={
                    row.supplier.id === selectedId ? 'page' : undefined
                  }
                  className={`flex min-h-16 border-s-2 focus-visible:outline-offset-[-2px] flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 transition-colors duration-150 hover:bg-surface-2 ${row.supplier.id === selectedId ? 'border-s-primary bg-primary-subtle' : 'border-s-transparent'}`}
                >
                  <span className="min-w-0 flex-[2_1_10rem]">
                    <span className="block truncate font-medium">
                      {String(row.supplier.name)}
                    </span>
                    <span
                      dir="ltr"
                      className="block text-small text-text-muted"
                    >
                      {String(row.supplier.phone ?? '')}
                    </span>
                  </span>
                  <span className="min-w-0 flex-[1_1_9rem] text-small">
                    <span
                      className={`block whitespace-nowrap font-medium ${supplierBalanceTone(row.balance)}`}
                    >
                      {supplierBalanceLabel(t, row.balance)}
                    </span>
                  </span>
                  <span className="min-w-0 flex-[1_1_9rem] text-small text-text-muted">
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
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </ListSurface>

      <SupplierDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
