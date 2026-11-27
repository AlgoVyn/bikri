import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { SearchIcon, SuppliersIcon } from '../components/icons.tsx';
import { ListPager } from '../components/ListPager.tsx';
import { ListSurface } from '../components/ListSurface.tsx';
import { Metric } from '../components/Metric.tsx';
import { MoneyText, useDisplayMoney } from '../components/MoneyText.tsx';
import { PageActions } from '../components/PageActions.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { SortDirectionButton, SortHeader } from '../components/SortHeader.tsx';
import { searchInputClass, searchWrapperClass } from '../components/search.ts';
import { getDb } from '../data/db.ts';
import {
  defaultSupplierSortDirection,
  filterSupplierList,
  loadSupplierListData,
  type SupplierSort,
  suppliersCsv,
} from '../data/suppliers.ts';
import { useShopTimeZone } from '../data/useShopTimeZone.ts';
import { downloadText } from '../lib/download.ts';
import { plainKey, useHotkey } from '../lib/hotkeys.ts';
import { rememberListScroll } from '../lib/listScroll.ts';
import { type SortDirection, toggleSortDirection } from '../lib/sort.ts';
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

const PAGE = 50;

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
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<SupplierSort>('name');
  const [direction, setDirection] = useState<SortDirection>(
    defaultSupplierSortDirection('name'),
  );
  const [newOpen, setNewOpen] = useState(false);
  const timeZone = useShopTimeZone();
  // Load the supplier directory once; a keystroke only filters/sorts in memory.
  const directory = useLiveQuery(() => loadSupplierListData(getDb()), []);
  const data = useMemo(
    () =>
      directory
        ? filterSupplierList(directory, {
            query: deferredQuery,
            sort,
            direction,
          })
        : undefined,
    [directory, deferredQuery, sort, direction],
  );

  const [page, setPage] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the search changes
  useEffect(() => setPage(0), [deferredQuery, sort, direction]);
  const pageCount = Math.max(1, Math.ceil((data?.rows.length ?? 0) / PAGE));
  const pageRows = data?.rows.slice(page * PAGE, (page + 1) * PAGE) ?? [];

  const applySort = (next: SupplierSort) => {
    if (next === sort) {
      setDirection(toggleSortDirection);
      return;
    }
    setSort(next);
    setDirection(defaultSupplierSortDirection(next));
  };
  const changeSort = (next: SupplierSort) => {
    setSort(next);
    setDirection(defaultSupplierSortDirection(next));
  };
  const exportCsv = () => {
    if (!data) return;
    downloadText('bikri-suppliers.csv', suppliersCsv(data.rows));
  };

  useHotkey(plainKey('n'), () => setNewOpen(true), {
    enabled: can('party.edit') && !readOnly,
  });
  useHotkey(
    (event) =>
      event.key === 'F2' ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f'),
    () => searchRef.current?.focus(),
    { inFields: true },
  );

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
          <PageActions
            primary={
              can('party.edit') &&
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
              ) : undefined
            }
            secondary={
              can('export.data') ? (
                <button
                  type="button"
                  className={buttonQuiet}
                  disabled={!data || data.rows.length === 0}
                  onClick={exportCsv}
                >
                  {t('office.suppliers.export_csv')}
                </button>
              ) : null
            }
            more={
              can('export.data')
                ? [
                    {
                      label: t('office.suppliers.export_csv'),
                      mobileOnly: true,
                      disabled: !data || data.rows.length === 0,
                      onSelect: exportCsv,
                    },
                  ]
                : []
            }
          />
        }
      />

      <ListSurface
        toolbar={
          <search className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-[2_1_14rem] flex-col">
              <span className="mb-1 text-small">
                {t('office.suppliers.search')}
              </span>
              <span className={searchWrapperClass}>
                <SearchIcon />
                <input
                  ref={searchRef}
                  type="search"
                  autoComplete="off"
                  className={searchInputClass}
                  placeholder={t('office.suppliers.search_placeholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </span>
            </label>
            <div className="flex min-w-0 flex-[1_1_11rem] flex-col">
              <span className="mb-1 text-small">
                {t('office.suppliers.sort')}
              </span>
              <div className="flex gap-1">
                <select
                  aria-label={t('office.suppliers.sort')}
                  className="h-11 min-w-0 flex-1 rounded-control border border-border-strong bg-surface px-2 text-text"
                  value={sort}
                  onChange={(e) => changeSort(e.target.value as SupplierSort)}
                >
                  <option value="name">
                    {t('office.suppliers.col_supplier')}
                  </option>
                  <option value="balance">
                    {t('office.suppliers.balance')}
                  </option>
                  <option value="last">
                    {t('office.suppliers.col_last_delivery')}
                  </option>
                </select>
                <SortDirectionButton
                  direction={direction}
                  onToggle={() => setDirection(toggleSortDirection)}
                  testId="suppliers-sort-direction"
                />
              </div>
            </div>
          </search>
        }
        summary={
          data ? (
            <div className="grid grid-cols-2 gap-3">
              <Metric
                testId="suppliers-total"
                className="col-span-2 sm:col-span-1"
                label={t('office.suppliers.total_owed')}
                value={<MoneyText paisa={data.totalOwed} />}
              />
              <Metric
                label={t('nav.suppliers')}
                value={String(data.totalCount)}
              />
            </div>
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
          <>
            <ul className="flex flex-col divide-y divide-divider">
              <li
                className={`${SUPPLIER_GRID} hidden border-s-2 border-b border-s-transparent border-divider bg-surface-2 px-3 py-2 text-small text-text-muted sm:grid`}
                data-testid="suppliers-list-header"
              >
                <SortHeader
                  label={t('office.suppliers.col_supplier')}
                  active={sort === 'name'}
                  direction={direction}
                  onClick={() => applySort('name')}
                />
                <SortHeader
                  label={t('office.suppliers.balance')}
                  active={sort === 'balance'}
                  direction={direction}
                  onClick={() => applySort('balance')}
                />
                <SortHeader
                  label={t('office.suppliers.col_last_delivery')}
                  active={sort === 'last'}
                  direction={direction}
                  onClick={() => applySort('last')}
                />
              </li>
              {pageRows.map((row) => (
                <li key={row.supplier.id}>
                  <Link
                    to="/suppliers/$supplierId"
                    params={{ supplierId: row.supplier.id }}
                    resetScroll={false}
                    onClick={rememberListScroll}
                    aria-current={
                      row.supplier.id === selectedId ? 'page' : undefined
                    }
                    className={`${SUPPLIER_GRID} min-h-16 border-s-2 px-3 py-2 transition-colors duration-150 focus-visible:outline-offset-[-2px] hover:bg-surface-2 ${row.supplier.id === selectedId ? 'border-s-primary bg-primary-subtle text-primary-subtle-ink' : 'border-s-transparent'}`}
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
                    <span className="min-w-0 text-start">
                      {row.balance === 0 ? (
                        <span className="block whitespace-nowrap font-semibold text-text-muted">
                          {t('office.suppliers.settled')}
                        </span>
                      ) : (
                        <>
                          <span
                            className={`block whitespace-nowrap font-semibold ${supplierBalanceTone(row.balance)}`}
                          >
                            {row.balance > 0 ? (
                              <span className="sr-only">
                                {supplierBalanceLabel(t, row.balance, money)}
                              </span>
                            ) : null}
                            <span
                              aria-hidden={row.balance > 0 ? true : undefined}
                            >
                              <MoneyText paisa={row.balance} />
                            </span>
                          </span>
                          {row.balance < 0 ? (
                            <span className="block text-small text-success-subtle-ink">
                              {t('office.suppliers.advance_label')}
                            </span>
                          ) : null}
                        </>
                      )}
                    </span>
                    <span className="min-w-0 text-start text-small text-text-muted sm:text-start">
                      {row.lastDeliveryDate
                        ? dateText(
                            row.lastDeliveryDate,
                            i18n.language,
                            timeZone,
                          )
                        : '—'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <ListPager page={page} pageCount={pageCount} onPage={setPage} />
          </>
        ) : null}
      </ListSurface>

      <SupplierDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
