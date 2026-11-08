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
import { MoneyText, useDisplayMoney } from '../components/MoneyText.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { searchInputClass, searchWrapperClass } from '../components/search.ts';
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

const SUPPLIER_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)] sm:gap-3';

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
  const money = useDisplayMoney();
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
    enabled: can('party.edit') && !readOnly,
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
        hideTitleOnPhone
        actions={
          <>
            {can('export.data') ? (
              <button
                type="button"
                className={buttonQuiet}
                disabled={!data || data.rows.length === 0}
                onClick={() =>
                  data &&
                  downloadText('bikri-suppliers.csv', suppliersCsv(data.rows))
                }
              >
                {t('office.suppliers.export_csv')}
              </button>
            ) : null}
            {can('party.edit') &&
            !detailOpen &&
            (Boolean(readOnly) || !data || data.rows.length > 0) ? (
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
              <span className={searchWrapperClass}>
                <SearchIcon />
                <input
                  type="search"
                  autoComplete="off"
                  className={searchInputClass}
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
                : can('party.edit') && !readOnly
                  ? t('office.suppliers.new_supplier')
                  : undefined
            }
            onAction={
              query
                ? () => setQuery('')
                : can('party.edit') && !readOnly
                  ? () => setNewOpen(true)
                  : undefined
            }
          />
        ) : null}

        {data && data.rows.length > 0 ? (
          <ul className="flex flex-col divide-y divide-border">
            <li
              className={`${SUPPLIER_GRID} hidden border-s-2 border-b border-s-transparent border-border bg-surface-2 px-3 py-2 text-small text-text-muted sm:grid`}
              aria-hidden="true"
              data-testid="suppliers-list-header"
            >
              <span>{t('office.suppliers.col_supplier')}</span>
              <span className="text-end">{t('office.suppliers.balance')}</span>
              <span>{t('office.suppliers.col_last_delivery')}</span>
            </li>
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
                  className={`${SUPPLIER_GRID} min-h-16 border-s-2 px-3 py-2 transition-colors duration-150 focus-visible:outline-offset-[-2px] hover:bg-surface-2 ${row.supplier.id === selectedId ? 'border-s-primary bg-primary-subtle' : 'border-s-transparent'}`}
                >
                  <span className="col-span-2 min-w-0 sm:col-span-1">
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
                  <span className="min-w-0 text-end">
                    <span
                      className={`block whitespace-nowrap font-semibold ${supplierBalanceTone(row.balance)}`}
                    >
                      {row.balance > 0 ? (
                        <span className="sr-only">
                          {supplierBalanceLabel(t, row.balance, money)}
                        </span>
                      ) : null}
                      <span aria-hidden={row.balance > 0 ? true : undefined}>
                        <MoneyText paisa={row.balance} />
                      </span>
                    </span>
                    {row.balance < 0 ? (
                      <span className="block text-small text-success-subtle-ink">
                        {t('office.suppliers.advance_label')}
                      </span>
                    ) : row.balance === 0 ? (
                      <span className="block text-small text-text-muted">
                        {t('office.suppliers.settled')}
                      </span>
                    ) : null}
                  </span>
                  <span className="min-w-0 text-end text-small text-text-muted sm:text-start">
                    {row.lastDeliveryDate
                      ? dateText(row.lastDeliveryDate, i18n.language, data.tz)
                      : '—'}
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
