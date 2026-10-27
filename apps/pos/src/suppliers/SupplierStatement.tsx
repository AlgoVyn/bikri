import { businessDate } from '@bikri/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
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
export function SupplierStatement({ supplierId }: { supplierId: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useCurrentStaff();
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
    { enabled: can('purchase.create') },
  );
  useHotkey(plainKey('p'), () => setPayOpen(true), {
    enabled: can('purchase.create'),
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
    <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <Link to="/suppliers" className={buttonQuiet}>
          {t('office.suppliers.back')}
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-h1 font-semibold">{name}</h1>
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
              className={`${buttonPrimary} gap-2`}
            >
              {t('office.suppliers.record_delivery')} <KeyBadge keys="D" />
            </Link>
            <button
              type="button"
              className={`${buttonQuiet} gap-2`}
              onClick={() => setPayOpen(true)}
            >
              {t('office.suppliers.pay_supplier')} <KeyBadge keys="P" />
            </button>
            <Link
              to="/suppliers/$supplierId/return/new"
              params={{ supplierId }}
              className={buttonQuiet}
            >
              {t('office.suppliers.return_supplier')}
            </Link>
          </>
        ) : null}
        {can('purchase.create') ? (
          <button
            type="button"
            className={buttonQuiet}
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

      <div className="overflow-auto rounded-card border border-border">
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
                    {row.kind === 'purchase' && row.entry.source_id ? (
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
      </div>

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
