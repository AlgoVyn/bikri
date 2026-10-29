import { businessDate } from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
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
  supplierBalanceTone,
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
  if (!data) return <p className="sr-only">{t('common.loading')}</p>;

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
    <div
      className={
        embedded
          ? 'flex min-w-0 flex-col gap-3'
          : 'mx-auto flex max-w-5xl flex-col gap-3 p-4'
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <Link
            to="/suppliers"
            aria-label={t('office.suppliers.back')}
            title={t('office.suppliers.back')}
            className={
              embedded
                ? 'inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface text-text hover:bg-surface-2'
                : buttonQuiet
            }
          >
            {embedded ? (
              <span
                aria-hidden="true"
                className="text-title leading-none rtl:rotate-180"
              >
                ‹
              </span>
            ) : (
              t('office.suppliers.back')
            )}
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-h1 font-semibold">{name}</h1>
            {supplier.phone ? (
              <a
                href={`tel:${String(supplier.phone)}`}
                dir="ltr"
                className="text-small underline"
              >
                {String(supplier.phone)}
              </a>
            ) : null}
          </div>
        </div>
        <p
          className={`text-figure font-semibold ${supplierBalanceTone(balance)}`}
          data-testid="supplier-balance"
        >
          {supplierBalanceLabel(t, balance)}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {can('purchase.create') ? (
          <>
            <Link
              to="/suppliers/$supplierId/delivery/new"
              params={{ supplierId }}
              className={`${buttonPrimary} gap-2 ${readOnly ? 'pointer-events-none opacity-50' : ''}`}
              aria-disabled={readOnly}
              onClick={(event) => {
                if (readOnly) event.preventDefault();
              }}
            >
              {t('office.suppliers.record_delivery')}
            </Link>
            <button
              type="button"
              className={`${buttonQuiet} gap-2`}
              disabled={readOnly}
              onClick={() => setPayOpen(true)}
            >
              {t('office.suppliers.pay_supplier')}
            </button>
            <Link
              to="/suppliers/$supplierId/return/new"
              params={{ supplierId }}
              className={`${buttonQuiet} ${readOnly ? 'pointer-events-none opacity-50' : ''}`}
              aria-disabled={readOnly}
              onClick={(event) => {
                if (readOnly) event.preventDefault();
              }}
            >
              {t('office.suppliers.return_supplier')}
            </Link>
          </>
        ) : null}
        {can('purchase.create') ? (
          <button
            type="button"
            className={buttonQuiet}
            disabled={readOnly}
            onClick={() => setEditOpen(true)}
          >
            {t('office.suppliers.edit')}
          </button>
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
      </div>

      <ul className="flex flex-col gap-2 sm:hidden">
        {rows.length === 0 ? (
          <li className="rounded-card border border-border bg-surface p-4 text-center text-text-muted">
            {t('office.suppliers.no_entries')}
          </li>
        ) : (
          statement.rows.map((row, index) => (
            <li
              key={row.entry.id}
              className="rounded-card border border-border bg-surface p-3 text-small"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-text-muted">
                  {dateText(String(row.entry.business_date), i18n.language, tz)}
                </span>
                <span className="font-medium">
                  <MoneyText paisa={row.balance} />
                </span>
              </div>
              <p className="mt-1">
                {rows[index]?.description}
                {row.kind === 'purchase' &&
                row.entry.source_id &&
                can('purchase.create') &&
                !readOnly ? (
                  <Link
                    to="/suppliers/$supplierId/return/new"
                    params={{ supplierId }}
                    search={{ purchase: String(row.entry.source_id) }}
                    className="ms-2 text-small underline"
                  >
                    {t('office.suppliers.return_items')}
                  </Link>
                ) : null}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <dt className="text-text-muted">
                    {t('office.suppliers.got')}
                  </dt>
                  <dd className="text-end">
                    {row.got > 0 ? <MoneyText paisa={row.got} /> : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">
                    {t('office.suppliers.paid')}
                  </dt>
                  <dd className="text-end">
                    {row.paid > 0 ? <MoneyText paisa={row.paid} /> : '—'}
                  </dd>
                </div>
              </dl>
            </li>
          ))
        )}
      </ul>

      <section
        className="hidden overflow-auto rounded-card border border-border sm:block"
        aria-label={t('office.suppliers.statement')}
        tabIndex={0}
      >
        <table className="w-full min-w-[32rem] text-small">
          <thead className="bg-surface">
            <tr className="border-b border-border text-text-muted">
              <th className="p-2 text-start">{t('office.suppliers.date')}</th>
              <th className="p-2 text-start">
                {t('office.suppliers.description')}
              </th>
              <th className="p-2 text-end">{t('office.suppliers.got')}</th>
              <th className="p-2 text-end">{t('office.suppliers.paid')}</th>
              <th className="p-2 text-end">{t('office.suppliers.balance')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-4 text-center text-text-muted">
                  {t('office.suppliers.no_entries')}
                </td>
              </tr>
            ) : (
              statement.rows.map((row, index) => (
                <tr
                  key={row.entry.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="p-2 whitespace-nowrap">
                    {dateText(
                      String(row.entry.business_date),
                      i18n.language,
                      tz,
                    )}
                  </td>
                  <td className="p-2">
                    {rows[index]?.description}
                    {row.kind === 'purchase' &&
                    row.entry.source_id &&
                    can('purchase.create') &&
                    !readOnly ? (
                      <Link
                        to="/suppliers/$supplierId/return/new"
                        params={{ supplierId }}
                        search={{ purchase: String(row.entry.source_id) }}
                        className="ms-2 text-small underline"
                      >
                        {t('office.suppliers.return_items')}
                      </Link>
                    ) : null}
                  </td>
                  <td className="p-2 text-end">
                    {row.got > 0 ? <MoneyText paisa={row.got} /> : '—'}
                  </td>
                  <td className="p-2 text-end">
                    {row.paid > 0 ? <MoneyText paisa={row.paid} /> : '—'}
                  </td>
                  <td className="p-2 text-end font-medium">
                    <MoneyText paisa={row.balance} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

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
    </div>
  );
}
