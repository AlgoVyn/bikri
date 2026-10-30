import { businessDate } from '@bikri/core';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
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
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { CustomerDialog } from './CustomerDialog.tsx';
import { ageLabel, balanceLabel, balanceTone, limitPercent } from './format.ts';

const selectClass =
  'h-11 min-w-0 rounded-control border border-border-strong bg-surface px-2 text-text';

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
    <div
      className={
        embedded
          ? 'flex min-w-0 flex-col gap-3'
          : 'mx-auto flex max-w-6xl flex-col gap-3 p-4'
      }
    >
      <PageHeader
        icon={<UdhaarIcon />}
        tone="bg-warning-subtle text-warning-subtle-ink"
        title={t('office.udhaar.title')}
        subtitle={t('office.udhaar.subtitle')}
        headingLevel={detailOpen ? 'h2' : 'h1'}
        actions={
          <>
            <Link to="/udhaar/chase" className={buttonQuiet}>
              {t('office.udhaar.chase_list')}
            </Link>
            {can('export.data') ? (
              <button
                type="button"
                className={buttonQuiet}
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
              </button>
            ) : null}
            {can('party.edit') ? (
              <button
                type="button"
                className={`${buttonPrimary} gap-2`}
                disabled={readOnly}
                onClick={() => setNewOpen(true)}
              >
                {t('office.udhaar.new_customer')}
              </button>
            ) : null}
          </>
        }
      />

      {data ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Card
            testid="udhaar-total"
            className="col-span-2 sm:col-span-1"
            label={t('office.udhaar.total_owed')}
            value={<MoneyText paisa={data.totalOwed} />}
          />
          <Card
            testid="udhaar-owing"
            label={t('office.udhaar.customers_owing')}
            value={String(data.owingCount)}
          />
          <Card
            label={t('office.udhaar.received_this_month')}
            value={<MoneyText paisa={data.receivedThisMonth} />}
          />
        </div>
      ) : null}

      <search className="flex flex-wrap items-end gap-2 rounded-card border border-border bg-surface p-3 shadow-card">
        <label className="flex min-w-0 flex-[2_1_14rem] flex-col">
          <span className="mb-1 text-small">{t('office.udhaar.search')}</span>
          <span className="flex h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-3">
            <SearchIcon />
            <input
              type="search"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-body outline-none"
              placeholder={t('office.udhaar.search_placeholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </span>
        </label>
        <button
          type="button"
          className={`${buttonQuiet} gap-2 self-end sm:hidden`}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          {t('common.filters')}
          {activeFilterCount > 0 ? (
            <span className="rounded-full bg-primary px-1.5 text-small text-primary-ink">
              {activeFilterCount}
            </span>
          ) : null}
        </button>
        <div
          className={
            filtersOpen
              ? 'flex w-full flex-wrap items-end gap-2'
              : 'hidden sm:flex sm:flex-wrap sm:items-end sm:gap-2'
          }
        >
          <label className="flex flex-col">
            <span className="mb-1 text-small">{t('office.udhaar.filter')}</span>
            <select
              className={selectClass}
              value={filter}
              onChange={(e) => setFilter(e.target.value as CustomerFilter)}
            >
              {filters.map((value) => (
                <option key={value} value={value}>
                  {t(`office.udhaar.filter_${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col">
            <span className="mb-1 text-small">{t('office.udhaar.sort')}</span>
            <select
              className={selectClass}
              value={sort}
              onChange={(e) => setSort(e.target.value as CustomerSort)}
            >
              {sorts.map((value) => (
                <option key={value} value={value}>
                  {t(`office.udhaar.sort_${value}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </search>

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
            can('party.edit') && !readOnly ? () => setNewOpen(true) : undefined
          }
        />
      ) : null}

      {data && data.rows.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
          {data.rows.map((row) => {
            const percent = limitPercent(
              row.balance,
              row.customer.credit_limit === null ||
                row.customer.credit_limit === undefined
                ? null
                : Number(row.customer.credit_limit),
            );
            return (
              <li key={row.customer.id}>
                <Link
                  to="/udhaar/$customerId"
                  params={{ customerId: row.customer.id }}
                  aria-current={
                    row.customer.id === selectedId ? 'page' : undefined
                  }
                  className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 hover:bg-surface-2 ${row.customer.id === selectedId ? 'bg-primary-subtle' : ''}`}
                >
                  <span className="min-w-0 flex-[2_1_10rem]">
                    <span className="line-clamp-2 break-words font-medium">
                      {String(row.customer.name)}
                    </span>
                    <span
                      dir="ltr"
                      className="block text-small text-text-muted"
                    >
                      {String(row.customer.phone ?? '')}
                    </span>
                  </span>
                  <span className="min-w-0 flex-[1_1_8rem] text-small">
                    <span
                      className={`block whitespace-nowrap font-medium ${balanceTone(row.balance)}`}
                    >
                      {balanceLabel(t, row.balance)}
                    </span>
                    <span className="block text-text-muted">
                      {ageLabel(t, row.oldestUnpaidAt)}
                    </span>
                  </span>
                  <span className="min-w-0 flex-[1_1_8rem] text-small">
                    {percent !== null ? (
                      <>
                        <span
                          className="mb-1 block h-2 overflow-hidden rounded-full bg-surface-2"
                          role="img"
                          aria-label={t('office.udhaar.limit_bar', {
                            percent,
                          })}
                        >
                          <span
                            className={`block h-full ${percent >= 100 ? 'bg-danger' : percent >= 80 ? 'bg-warning' : 'bg-primary'}`}
                            style={{ width: `${percent}%` }}
                          />
                        </span>
                        <span className="flex flex-wrap items-center gap-x-1 text-text-muted">
                          <MoneyText paisa={row.balance} />
                          <span aria-hidden="true">/</span>
                          <MoneyText
                            paisa={Number(row.customer.credit_limit ?? 0)}
                          />
                        </span>
                      </>
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-[1_1_8rem] text-small text-text-muted">
                    {row.promise
                      ? t('office.udhaar.promise_on', {
                          date: String(row.promise.promised_on),
                        })
                      : ''}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}

      <CustomerDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}

function Card({
  label,
  value,
  testid,
  className = '',
}: {
  label: string;
  value: ReactNode;
  testid?: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded-card border border-border bg-surface p-2 sm:p-3 ${className}`}
      data-testid={testid}
    >
      <p className="text-small text-text-muted">{label}</p>
      <p className="text-title font-semibold">{value}</p>
    </div>
  );
}
