import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { SearchIcon, SuppliersIcon } from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import { supplierList, suppliersCsv } from '../data/suppliers.ts';
import { downloadText } from '../lib/download.ts';
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
export function SupplierList() {
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
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-h1 font-semibold">
          {t('office.suppliers.title')}
        </h1>
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
            {t('office.suppliers.new_supplier')} <KeyBadge keys="N" />
          </button>
        ) : null}
      </div>

      {data ? (
        <p className="rounded-card border border-border bg-surface p-3 text-small">
          {t('office.suppliers.total_owed')}:{' '}
          <span className="text-title font-semibold">
            <MoneyText paisa={data.totalOwed} />
          </span>
        </p>
      ) : null}

      <search>
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
        <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
          {data.rows.map((row) => (
            <li key={row.supplier.id}>
              <Link
                to="/suppliers/$supplierId"
                params={{ supplierId: row.supplier.id }}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 hover:bg-surface-2"
              >
                <span className="min-w-0 flex-[2_1_10rem]">
                  <span className="block truncate font-medium">
                    {String(row.supplier.name)}
                  </span>
                  <span dir="ltr" className="block text-small text-text-muted">
                    {String(row.supplier.phone ?? '')}
                  </span>
                </span>
                <span className="min-w-0 flex-[1_1_9rem] text-small">
                  <span
                    className={`block font-medium ${supplierBalanceTone(row.balance)}`}
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

      <SupplierDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
