import { businessDate } from '@bikri/core';
import type { RasterSource } from '@bikri/printer';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import { DateField } from '../components/DateField.tsx';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { ChevronRightIcon, SuppliersIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageActions } from '../components/PageActions.tsx';
import { PageLoading } from '../components/PageLoading';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/shopTimeZone.ts';
import {
  supplierBalance,
  supplierStatement,
  supplierStatementCsv,
} from '../data/suppliers.ts';
import { downloadText } from '../lib/download.ts';
import { plainKey, useHotkey } from '../lib/hotkeys.ts';
import { useRecordBack } from '../peek/recordBack.ts';
import { downloadBlob } from '../print/receiptImage.ts';
import { useMediaQuery } from '../shell/useMediaQuery.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { DeliveryDetailDialog } from './DeliveryDetailDialog.tsx';
import {
  dateText,
  supplierBalanceTone,
  supplierEntryDescription,
} from './format.ts';
import { PaySupplierDialog } from './PaySupplierDialog.tsx';
import { SupplierDialog } from './SupplierDialog.tsx';

const STATEMENT_PAGE = 200;

/** Supplier detail / ledger (screens/13). */
export function SupplierStatement({
  supplierId,
  embedded = false,
  initialDeliveryId,
}: {
  supplierId: string;
  embedded?: boolean;
  /** Opens the delivery details dialog directly (`?delivery=<purchaseId>`). */
  initialDeliveryId?: string;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const recordBack = useRecordBack('/suppliers', 'nav.suppliers');
  const { can, role } = useCurrentStaff();
  const canSeeDelivery = can('purchase.create') || can('cost.view');
  const readOnly = useReadOnly();
  const [payOpen, setPayOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deliveryId, setDeliveryId] = useState<string | null>(
    canSeeDelivery ? (initialDeliveryId ?? null) : null,
  );
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [visibleRows, setVisibleRows] = useState(STATEMENT_PAGE);
  // One layout at a time; the hidden one still mapped every entry and formatted
  // its dates (D-231).
  const wide = useMediaQuery('(min-width: 640px)');
  const range =
    from || to
      ? { from: from || '0000-01-01', to: to || '9999-12-31' }
      : undefined;
  const data = useLiveQuery(async () => {
    const db = getDb();
    const supplier = await db.suppliers.get(supplierId);
    if (!supplier || supplier.deleted_at) return null;
    const tz = await shopTimeZone(db);
    const shop = await db.shop.get('shop');
    return {
      supplier,
      statement: await supplierStatement(db, supplierId, visibleRows, range),
      balance: await supplierBalance(db, supplierId),
      tz,
      shopName: String(shop?.name ?? ''),
      shopAddress: String(shop?.address ?? ''),
      shopPhone: String(shop?.phone ?? ''),
      logo: ((await db.kv.get('logo_bitmap'))?.value ??
        null) as RasterSource | null,
    };
  }, [supplierId, from, to, visibleRows]);

  // A new supplier or date filter starts again at the newest page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter changes
  useEffect(() => setVisibleRows(STATEMENT_PAGE), [supplierId, from, to]);
  // Deep link from a stock movement: open the delivery even when this screen is mounted.
  // Without `purchase.create`/`cost.view` the dialog would reveal unit costs, so clear the
  // parameter instead of opening it (screens/13, UI-H1).
  useEffect(() => {
    if (!initialDeliveryId) {
      setDeliveryId(null);
      return;
    }
    if (!canSeeDelivery) {
      setDeliveryId(null);
      void navigate({
        to: '/suppliers/$supplierId',
        params: { supplierId },
        search: {},
        state: true,
        replace: true,
      });
      return;
    }
    setDeliveryId(initialDeliveryId);
  }, [initialDeliveryId, canSeeDelivery, navigate, supplierId]);

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
  useHotkey(
    plainKey('r'),
    () =>
      void navigate({
        to: '/suppliers/$supplierId/return/new',
        params: { supplierId },
      }),
    { enabled: can('purchase.create') && !readOnly },
  );

  const tz = data?.tz ?? 'Asia/Karachi';
  type StatementData = NonNullable<typeof data>['statement'];
  const mapRows = useCallback(
    (value: StatementData) =>
      value.rows.map((row) => ({
        date: dateText(String(row.entry.business_date), i18n.language, tz),
        description: supplierEntryDescription(t, row),
        got: row.got,
        paid: row.paid,
        debit: row.got,
        credit: row.paid,
        balance: row.balance,
        items: row.items,
      })),
    [i18n.language, tz, t],
  );
  const rows = useMemo(
    () => (data ? mapRows(data.statement) : []),
    [data, mapRows],
  );

  if (data === null)
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.suppliers.not_found')}
      </p>
    );
  if (!data) return <PageLoading compact />;

  const {
    supplier,
    statement,
    balance,
    shopName,
    shopAddress,
    shopPhone,
    logo,
  } = data;
  const name = String(supplier.name);
  const supplierPhone = String(supplier.phone ?? '');
  const supplierAddress = String(supplier.address ?? '');
  // The data layer returns the newest page; CSV/PDF/share load every row separately.
  const shownRows = statement.rows;
  const shownOpening = statement.openingBalance;
  const openDelivery = (purchaseId: string | null) => {
    if (purchaseId) setDeliveryId(purchaseId);
  };
  const periodValue =
    from || to
      ? `${from ? dateText(from, i18n.language, tz) : '…'} – ${
          to ? dateText(to, i18n.language, tz) : '…'
        }`
      : t('office.suppliers.all_time');
  const meta = {
    shopName,
    shopAddress,
    shopPhone,
    logo,
    customerName: name,
    phone: supplierPhone,
    balance,
    from: from || null,
    to: to || null,
    rows: rows.map((row) => ({
      date: row.date,
      description: row.description,
      debit: row.got,
      credit: row.paid,
      balance: row.balance,
      items: row.items,
    })),
    openingBalance: statement.openingBalance,
    lang: i18n.language,
    labels: {
      title: t('office.suppliers.statement'),
      customer: t('office.suppliers.statement_supplier'),
      phone: t('office.suppliers.phone'),
      period: t('office.suppliers.statement_period'),
      periodValue,
      date: t('office.suppliers.date'),
      description: t('office.suppliers.description'),
      debit: t('office.suppliers.statement_debit'),
      credit: t('office.suppliers.statement_credit'),
      balance: t('office.suppliers.balance'),
      opening: t('office.suppliers.entry_opening'),
      total: t('office.suppliers.total'),
      totalDebit: t('office.suppliers.total_debit'),
      totalCredit: t('office.suppliers.total_credit'),
      closing: t('office.suppliers.closing_balance'),
      generatedBy: t('office.suppliers.generated_by'),
      asOf: t('office.suppliers.as_of', {
        date: dateText(businessDate(Date.now(), tz), i18n.language, tz),
      }),
    },
  };
  const fullStatement = () =>
    supplierStatement(
      getDb(),
      supplierId,
      Number.POSITIVE_INFINITY,
      range,
      true,
    );
  const fullMeta = async () => {
    const full = await fullStatement();
    return {
      ...meta,
      rows: mapRows(full),
      openingBalance: full.openingBalance,
    };
  };
  const exportCsv = async () => {
    try {
      const full = await fullStatement();
      downloadText(
        `supplier-${name.replace(/\s+/gu, '-')}.csv`,
        supplierStatementCsv(mapRows(full)),
      );
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };
  const exportPdf = async () => {
    try {
      downloadBlob(
        await (await import('../udhaar/statementFile.ts')).statementPdf(
          await fullMeta(),
        ),
        `supplier-${name.replace(/\s+/gu, '-')}.pdf`,
      );
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };
  const share = async () => {
    try {
      const { statementPng } = await import('../udhaar/statementFile.ts');
      const png = await statementPng(await fullMeta());
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
        embedded ? 'flex min-w-0 flex-col gap-3' : pageClass('focused')
      }
    >
      <SubpageHeader
        backTo="/suppliers"
        backLabel={recordBack?.label ?? t('office.suppliers.back')}
        onBack={recordBack?.onActivate}
        hideBackBelowLg
        icon={<SuppliersIcon />}
        title={name}
        stackActions={embedded}
        subtitle={
          supplierPhone || supplierAddress ? (
            <span className="flex flex-col gap-0.5">
              {supplierPhone ? (
                <a
                  href={`tel:${supplierPhone}`}
                  dir="ltr"
                  className="underline"
                >
                  {supplierPhone}
                </a>
              ) : null}
              {supplierAddress ? (
                <span className="break-words">{supplierAddress}</span>
              ) : null}
            </span>
          ) : undefined
        }
        actions={
          <PageActions
            primary={
              can('purchase.create') ? (
                <Link
                  to="/suppliers/$supplierId/delivery/new"
                  params={{ supplierId }}
                  className={`${buttonPrimary} ${readOnly ? 'pointer-events-none bg-surface-2 text-text-muted' : ''}`}
                  aria-disabled={readOnly}
                  onClick={(event) => {
                    if (readOnly) event.preventDefault();
                  }}
                >
                  {t('office.suppliers.record_delivery')}
                </Link>
              ) : undefined
            }
            secondary={
              <>
                {can('purchase.create') ? (
                  <button
                    type="button"
                    className={buttonQuiet}
                    disabled={readOnly}
                    onClick={() => setPayOpen(true)}
                  >
                    {t('office.suppliers.pay_supplier')}
                  </button>
                ) : null}
                {can('export.data') && rows.length > 0 ? (
                  <ExportMenu
                    onCsv={() => void exportCsv()}
                    onPdf={() => void exportPdf()}
                    onShare={() => void share()}
                  />
                ) : null}
              </>
            }
            more={[
              ...(can('purchase.create')
                ? [
                    {
                      label: t('office.suppliers.return_supplier'),
                      to: `/suppliers/${supplierId}/return/new`,
                      disabled: readOnly,
                    },
                  ]
                : []),
              ...(can('party.edit') && role !== 'cashier'
                ? [
                    {
                      label: t('office.suppliers.edit'),
                      disabled: readOnly,
                      onSelect: () => setEditOpen(true),
                    },
                  ]
                : []),
            ]}
          />
        }
      />

      <section className="rounded-card border border-border bg-surface p-4 shadow-card">
        <div data-testid="supplier-balance">
          <p className="text-small text-text-muted">
            {balance > 0
              ? t('office.suppliers.you_owe_label')
              : balance < 0
                ? t('office.suppliers.advance_label')
                : t('office.suppliers.settled')}{' '}
          </p>
          {balance !== 0 ? (
            <p
              className={`mt-1 text-title font-semibold ${supplierBalanceTone(balance)}`}
            >
              <MoneyText paisa={Math.abs(balance)} />
            </p>
          ) : null}
        </div>
      </section>

      <div className="flex flex-wrap items-end gap-2">
        <DateField
          className="w-[9.5rem]"
          label={t('office.suppliers.from')}
          value={from}
          max={to}
          onChange={setFrom}
        />
        <DateField
          className="w-[9.5rem]"
          label={t('office.suppliers.to')}
          value={to}
          min={from}
          onChange={setTo}
        />
        {from || to ? (
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => {
              setFrom('');
              setTo('');
            }}
          >
            {t('office.suppliers.all_time')}
          </button>
        ) : null}
      </div>

      {!wide ? (
        <ul className="flex flex-col gap-2">
          {shownOpening !== 0 ? (
            <li className="flex items-center justify-between gap-2 rounded-card border border-border bg-surface p-3 text-small">
              <span>{t('office.suppliers.entry_opening')}</span>
              <span className="font-medium">
                <MoneyText paisa={shownOpening} />
              </span>
            </li>
          ) : null}
          {rows.length === 0 ? (
            <li className="rounded-card border border-border bg-surface p-4 text-center text-text-muted">
              {t('office.suppliers.no_entries')}
            </li>
          ) : (
            shownRows.map((row, index) => {
              const purchaseId =
                can('purchase.create') || can('cost.view')
                  ? row.kind === 'purchase' && row.entry.source_id
                    ? String(row.entry.source_id)
                    : null
                  : null;
              return (
                <li
                  key={row.entry.id}
                  className={`relative rounded-card border border-border bg-surface p-3 text-small ${
                    purchaseId ? 'hover:bg-surface-2' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-text-muted">
                      {dateText(
                        String(row.entry.business_date),
                        i18n.language,
                        tz,
                      )}
                    </span>
                    <span className="font-medium">
                      <MoneyText paisa={row.balance} />
                    </span>
                  </div>
                  {purchaseId ? (
                    <button
                      type="button"
                      className="mt-1 flex items-center gap-1 text-start underline-offset-2 hover:underline"
                      onClick={() => openDelivery(purchaseId)}
                    >
                      {rows[index]?.description}
                      <ChevronRightIcon className="size-3.5 shrink-0 rtl:rotate-180" />
                    </button>
                  ) : (
                    <p className="mt-1 flex items-center gap-1">
                      {rows[index]?.description}
                    </p>
                  )}
                  <dl className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <dt className="text-text-muted">
                        {t('office.suppliers.got')}
                      </dt>
                      <dd className="text-start">
                        {row.got > 0 ? <MoneyText paisa={row.got} /> : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-text-muted">
                        {t('office.suppliers.paid')}
                      </dt>
                      <dd className="text-start">
                        {row.paid > 0 ? <MoneyText paisa={row.paid} /> : '—'}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })
          )}
        </ul>
      ) : null}

      {wide ? (
        <section
          className="overflow-auto rounded-card border border-border"
          aria-label={t('office.suppliers.statement')}
        >
          <table className="w-full min-w-[32rem] text-small">
            <thead className="bg-surface">
              <tr className="border-b border-border text-text-muted">
                <th className="p-2 text-start">{t('office.suppliers.date')}</th>
                <th className="p-2 text-start">
                  {t('office.suppliers.description')}
                </th>
                <th className="p-2 text-start">{t('office.suppliers.got')}</th>
                <th className="p-2 text-start">{t('office.suppliers.paid')}</th>
                <th className="p-2 text-start">
                  {t('office.suppliers.balance')}
                </th>
              </tr>
            </thead>
            <tbody>
              {shownOpening !== 0 ? (
                <tr className="border-b border-border">
                  <td className="p-2" />
                  <td className="p-2">{t('office.suppliers.entry_opening')}</td>
                  <td className="p-2" />
                  <td className="p-2" />
                  <td className="p-2 text-start">
                    <MoneyText paisa={shownOpening} />
                  </td>
                </tr>
              ) : null}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-text-muted">
                    {t('office.suppliers.no_entries')}
                  </td>
                </tr>
              ) : (
                shownRows.map((row, index) => {
                  const purchaseId =
                    can('purchase.create') || can('cost.view')
                      ? row.kind === 'purchase' && row.entry.source_id
                        ? String(row.entry.source_id)
                        : null
                      : null;
                  return (
                    <tr
                      key={row.entry.id}
                      className={`border-b border-border last:border-0 ${
                        purchaseId ? 'hover:bg-surface-2' : ''
                      }`}
                    >
                      <td className="p-2 whitespace-nowrap">
                        {rows[index]?.date}
                      </td>
                      <td className="p-2">
                        {purchaseId ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-start underline-offset-2 hover:underline"
                            onClick={() => openDelivery(purchaseId)}
                          >
                            {rows[index]?.description}
                            <ChevronRightIcon className="size-3.5 shrink-0 rtl:rotate-180" />
                          </button>
                        ) : (
                          rows[index]?.description
                        )}
                      </td>
                      <td className="p-2 text-start">
                        {row.got > 0 ? <MoneyText paisa={row.got} /> : '—'}
                      </td>
                      <td className="p-2 text-start">
                        {row.paid > 0 ? <MoneyText paisa={row.paid} /> : '—'}
                      </td>
                      <td className="p-2 text-start font-medium">
                        <MoneyText paisa={row.balance} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </section>
      ) : null}

      {statement.hasMore ? (
        <button
          type="button"
          className={buttonQuiet}
          onClick={() => setVisibleRows((count) => count + STATEMENT_PAGE)}
        >
          {t('office.suppliers.show_older')}
        </button>
      ) : null}

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
      <DeliveryDetailDialog
        purchaseId={deliveryId}
        open={deliveryId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeliveryId(null);
            if (initialDeliveryId)
              void navigate({
                to: '/suppliers/$supplierId',
                params: { supplierId },
                search: {},
                state: true,
                replace: true,
              });
          }
        }}
      />
    </div>
  );
}
