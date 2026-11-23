import { businessDate } from '@bikri/core';
import type { RasterSource } from '@bikri/printer';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import { DateField } from '../components/DateField.tsx';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { UsersIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { PageActions } from '../components/PageActions.tsx';
import { PageLoading } from '../components/PageLoading';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import { emptyCart } from '../data/cart.ts';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/shopTimeZone.ts';
import {
  customerStatement,
  refreshPromises,
  reminderLink,
  reminderMessage,
  type Statement,
  statementCsv,
} from '../data/udhaar.ts';
import { downloadText } from '../lib/download.ts';
import { errorCode } from '../print/printService.ts';
import { downloadBlob } from '../print/receiptImage.ts';
import {
  closeShareWindow,
  navigateShareWindow,
  openShareWindow,
} from '../print/shareWindow.ts';
import { useSellStore } from '../sell/sellStore.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useMediaQuery } from '../shell/useMediaQuery.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { CustomerDialog } from './CustomerDialog.tsx';
import { printCustomerStatement } from './creditPrint.ts';
import {
  ageLabel,
  balanceTone,
  dateText,
  entryDescription,
  entryDescriptionShort,
  limitPercent,
  shortDateText,
} from './format.ts';
import { PromiseDialog } from './PromiseDialog.tsx';
import { ReceivePaymentDialog } from './ReceivePaymentDialog.tsx';

const STATEMENT_PAGE = 200;

/** Customer khata statement (screens/12). */
export function CustomerStatement({
  customerId,
  embedded = false,
}: {
  customerId: string;
  embedded?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { can, role, staff } = useCurrentStaff();
  const readOnly = useReadOnly();
  const canEditPromises = can('party.edit');
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [promiseOpen, setPromiseOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [visibleRows, setVisibleRows] = useState(STATEMENT_PAGE);
  const tableRef = useRef<HTMLDivElement>(null);
  // Render one layout: the card list and the table both mapped every entry and
  // formatted two dates per row, even when CSS hid one of them (D-231).
  const wide = useMediaQuery('(min-width: 640px)');

  useEffect(() => {
    if (!canEditPromises) return;
    void (async () => {
      const db = getDb();
      const tz = await shopTimeZone(db);
      await refreshPromises(db, {
        today: businessDate(Date.now(), tz),
        actor: staff?.id ?? null,
      });
    })().catch(() => undefined);
  }, [canEditPromises, staff?.id]);

  const range =
    from || to
      ? { from: from || '0000-01-01', to: to || '9999-12-31' }
      : undefined;
  const data = useLiveQuery(async () => {
    const db = getDb();
    const customer = await db.customers.get(customerId);
    if (!customer) return null;
    const tz = await shopTimeZone(db);
    const today = businessDate(Date.now(), tz);
    const statement = await customerStatement(
      db,
      customerId,
      range,
      visibleRows,
    );
    const balanceRow = await db.party_balances.get(['customer', customerId]);
    const promise = (
      await db.promises.where('customer_id').equals(customerId).toArray()
    )
      .filter((p) => !p.deleted_at && p.status === 'open')
      .sort((a, b) =>
        String(a.promised_on).localeCompare(String(b.promised_on)),
      )[0];
    const shop = await db.shop.get('shop');
    return {
      customer,
      statement,
      tz,
      today,
      balance: balanceRow?.balance ?? statement.balance,
      oldest: balanceRow?.oldest_unpaid_at,
      promise: promise ?? null,
      shopName: String(shop?.name ?? ''),
      shopAddress: String(shop?.address ?? ''),
      shopPhone: String(shop?.phone ?? ''),
      showLogo: Number(shop?.show_logo_on_receipt ?? 1) !== 0,
      showShopName: Number(shop?.show_shop_name_on_receipt ?? 1) !== 0,
      logo: ((await db.kv.get('logo_bitmap'))?.value ??
        null) as RasterSource | null,
    };
  }, [customerId, from, to, visibleRows]);

  // A new customer or date filter starts again at the newest page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter changes
  useEffect(() => setVisibleRows(STATEMENT_PAGE), [customerId, from, to]);

  useHotkey(plainKey('r'), () => setReceiveOpen(true), {
    enabled: can('payment.receive') && !readOnly,
  });

  if (data === null)
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.udhaar.not_found')}
      </p>
    );
  if (!data) return <PageLoading compact />;

  const {
    customer,
    statement,
    tz,
    today,
    balance,
    shopName,
    shopAddress,
    shopPhone,
    showLogo,
    showShopName,
    logo,
  } = data;
  const phone = String(customer.phone ?? '');
  const name = String(customer.name);
  const reminder = reminderLink(
    phone,
    reminderMessage(i18n.language as 'en' | 'ur' | 'roman-ur', {
      name,
      shop: shopName,
      balance,
      date: dateText(today, i18n.language, tz),
    }),
  );
  const mapRows = (value: Statement) =>
    value.rows.map((row) => ({
      date: dateText(String(row.entry.business_date), i18n.language, tz),
      dateShort: shortDateText(String(row.entry.business_date), tz),
      description: entryDescription(t, row),
      descriptionShort: entryDescriptionShort(t, row),
      debit: row.debit,
      credit: row.credit,
      balance: row.balance,
      voided: row.voided,
      items: row.items,
    }));
  const rows = mapRows(statement);
  // The data layer returns the newest page; the printed statement and CSV load every
  // row separately, so paging the screen does not truncate an export.
  const shownRows = statement.rows;
  const shownOpening = statement.openingBalance;
  const periodValue =
    from || to
      ? `${from ? dateText(from, i18n.language, tz) : '…'} – ${
          to ? dateText(to, i18n.language, tz) : '…'
        }`
      : t('office.udhaar.all_time');
  const meta = {
    shopName,
    shopAddress,
    shopPhone,
    logo,
    showLogo,
    showShopName,
    customerName: name,
    phone,
    balance,
    from: from || null,
    to: to || null,
    rows,
    openingBalance: statement.openingBalance,
    lang: i18n.language,
    labels: {
      title: t('office.udhaar.statement'),
      customer: t('office.udhaar.statement_customer'),
      phone: t('office.udhaar.phone'),
      period: t('office.udhaar.statement_period'),
      periodValue,
      date: t('office.udhaar.date'),
      description: t('office.udhaar.description'),
      debit: t('office.udhaar.statement_debit'),
      credit: t('office.udhaar.statement_credit'),
      balance: t('office.udhaar.balance'),
      opening: t('office.udhaar.entry_opening'),
      total: t('office.udhaar.total'),
      totalDebit: t('office.udhaar.total_debit'),
      totalCredit: t('office.udhaar.total_credit'),
      closing: t('office.udhaar.closing_balance'),
      generatedBy: t('office.udhaar.generated_by'),
      asOf: t('office.udhaar.as_of', {
        date: dateText(today, i18n.language, tz),
      }),
    },
  };
  // Every export carries the bill's item lines and leaves out voided bills and
  // their reversing rows; only the screen shows the full history.
  const fullStatement = () =>
    customerStatement(
      getDb(),
      customerId,
      range,
      Number.POSITIVE_INFINITY,
      true,
      false,
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
        `statement-${name.replace(/\s+/gu, '-')}.csv`,
        statementCsv(mapRows(full)),
      );
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };
  const exportPdf = async () => {
    try {
      downloadBlob(
        await (await import('./statementFile.ts')).statementPdf(
          await fullMeta(),
        ),
        `statement-${name.replace(/\s+/gu, '-')}.pdf`,
      );
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };
  const printStatement = async () => {
    try {
      await printCustomerStatement(getDb(), await fullMeta());
    } catch (err) {
      toast.push(t(`print.err_${errorCode(err)}`), 'error');
    }
  };
  const share = async () => {
    // Pre-open the WhatsApp tab during the click; opening it after the PNG awaits
    // is blocked as a popup.
    const shareWindow = reminder ? openShareWindow() : null;
    try {
      const { statementPng } = await import('./statementFile.ts');
      const png = await statementPng(await fullMeta());
      const file = new File([png], `statement-${name}.png`, {
        type: 'image/png',
      });
      // With a phone, hand the picture to WhatsApp the same way the reminder does.
      if (reminder) {
        downloadBlob(png, file.name);
        if (navigateShareWindow(shareWindow, reminder))
          toast.push(t('done.image_saved'));
        else {
          closeShareWindow(shareWindow);
          toast.push(t('done.share_blocked'), 'error');
        }
      } else if (navigator.canShare?.({ files: [file] }))
        await navigator.share({ files: [file], title: name });
      else {
        downloadBlob(png, file.name);
        toast.push(t('done.image_saved'));
      }
    } catch (err) {
      closeShareWindow(shareWindow);
      if ((err as Error).name !== 'AbortError')
        toast.push(t('done.share_failed'), 'error');
    }
  };

  const sellTo = async () => {
    const db = getDb();
    const active = useSellStore.getState().active;
    const cart = (await db.carts.get(active)) ?? emptyCart(active);
    await db.carts.put({
      ...cart,
      customer_id: customerId,
      updated_at: Date.now(),
    });
    useSellStore.getState().setActive(active);
    void navigate({ to: '/sell' });
  };

  const percent = limitPercent(
    balance,
    customer.credit_limit === null || customer.credit_limit === undefined
      ? null
      : Number(customer.credit_limit),
  );

  return (
    <div
      className={
        embedded ? 'flex min-w-0 flex-col gap-3' : pageClass('focused')
      }
    >
      <SubpageHeader
        backTo="/udhaar"
        backLabel={t('office.udhaar.back_customers')}
        icon={<UsersIcon />}
        title={name}
        stackActions={embedded}
        subtitle={
          phone ? (
            <a href={`tel:${phone}`} dir="ltr" className="underline">
              {phone}
            </a>
          ) : undefined
        }
        actions={
          <PageActions
            primary={
              can('payment.receive') ? (
                <button
                  type="button"
                  className={buttonPrimary}
                  disabled={readOnly}
                  onClick={() => setReceiveOpen(true)}
                >
                  {t('office.udhaar.receive_money')}
                </button>
              ) : undefined
            }
            secondary={
              <>
                <button
                  type="button"
                  className={buttonQuiet}
                  disabled={!reminder}
                  title={
                    reminder ? undefined : t('office.udhaar.reminder_no_phone')
                  }
                  onClick={() => {
                    if (reminder) window.open(reminder, '_blank', 'noopener');
                  }}
                >
                  {t('office.udhaar.send_reminder')}
                </button>
                {can('export.data') ? (
                  <>
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => void printStatement()}
                    >
                      {t('office.udhaar.print_statement')}
                    </button>
                    <ExportMenu
                      onCsv={exportCsv}
                      onPdf={() => void exportPdf()}
                      onShare={() => void share()}
                    />
                  </>
                ) : null}
              </>
            }
            more={[
              ...(can('party.edit')
                ? [
                    {
                      label: t('office.udhaar.add_promise'),
                      disabled: readOnly,
                      onSelect: () => setPromiseOpen(true),
                    },
                    ...(role !== 'cashier'
                      ? [
                          {
                            label: t('office.udhaar.edit'),
                            disabled: readOnly,
                            onSelect: () => setEditOpen(true),
                          },
                        ]
                      : []),
                  ]
                : []),
              ...(can('sale.create') && !readOnly
                ? [
                    {
                      label: t('office.udhaar.sell_to', { name }),
                      onSelect: () => void sellTo(),
                    },
                  ]
                : []),
            ]}
          />
        }
      />

      <section className="rounded-card border border-border bg-surface p-4 shadow-card">
        <div className="grid grid-cols-2 gap-3">
          <div data-testid="statement-balance">
            <p className="text-small text-text-muted">
              {balance > 0
                ? t('office.udhaar.owes_label')
                : balance < 0
                  ? t('office.udhaar.in_credit_label')
                  : t('office.udhaar.settled')}{' '}
            </p>
            {balance !== 0 ? (
              <p
                className={`mt-1 text-title font-semibold ${balanceTone(balance)}`}
              >
                <MoneyText paisa={Math.abs(balance)} />
              </p>
            ) : null}
          </div>
          <div>
            <p className="text-small text-text-muted">
              {t('office.udhaar.limit')}
            </p>
            <p className="mt-1 text-title font-semibold">
              {customer.credit_limit === null ||
              customer.credit_limit === undefined ? (
                t('office.udhaar.no_limit')
              ) : (
                <MoneyText paisa={Number(customer.credit_limit)} />
              )}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-small">
          {percent !== null ? (
            <>
              <span
                className="h-2 w-40 overflow-hidden rounded-full bg-surface-2"
                role="img"
                aria-label={t('office.udhaar.limit_bar', { percent })}
              >
                <span
                  className={`block h-full ${percent >= 100 ? 'bg-danger' : percent >= 80 ? 'bg-warning' : 'bg-primary'}`}
                  style={{ width: `${percent}%` }}
                />
              </span>
              <span
                className={
                  percent >= 100
                    ? 'text-danger'
                    : percent >= 80
                      ? 'text-warning'
                      : 'text-text-muted'
                }
              >
                {percent}%
                {percent >= 100
                  ? ` · ${t('office.udhaar.over_limit')}`
                  : percent >= 80
                    ? ` · ${t('office.udhaar.near_limit')}`
                    : ''}
              </span>
            </>
          ) : null}
          <span className="text-text-muted">
            {ageLabel(t, data.oldest ?? null)}
          </span>
          {data.promise ? (
            <span className="text-text-muted">
              {t('office.udhaar.promise_on', {
                date: dateText(
                  String(data.promise.promised_on),
                  i18n.language,
                  tz,
                ),
              })}
            </span>
          ) : null}
        </div>
      </section>

      <div className="flex flex-wrap items-end gap-2">
        <DateField
          className="w-[9.5rem]"
          label={t('office.udhaar.from')}
          value={from}
          max={to}
          onChange={setFrom}
        />
        <DateField
          className="w-[9.5rem]"
          label={t('office.udhaar.to')}
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
            {t('office.udhaar.all_time')}
          </button>
        ) : null}
        {wide ? (
          <button
            type="button"
            className={buttonQuiet}
            onClick={() =>
              tableRef.current?.scrollTo({
                top: tableRef.current.scrollHeight,
                behavior: 'smooth',
              })
            }
          >
            {t('office.udhaar.jump_latest')}
          </button>
        ) : null}
      </div>

      {!wide ? (
        <ul className="flex flex-col gap-2">
          {shownOpening !== 0 ? (
            <li className="flex items-center justify-between gap-2 rounded-card border border-border bg-surface p-3 text-small">
              <span>{t('office.udhaar.entry_opening')}</span>
              <span className="font-medium">
                <MoneyText paisa={shownOpening} />
              </span>
            </li>
          ) : null}
          {rows.length === 0 ? (
            <li className="rounded-card border border-border bg-surface p-4 text-center text-text-muted">
              {t('office.udhaar.no_entries')}
            </li>
          ) : (
            shownRows.map((row, index) => (
              <li
                key={row.entry.id}
                className="rounded-card border border-border bg-surface p-3 text-small"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-text-muted">{rows[index]?.date}</span>
                  <span className="font-medium">
                    <MoneyText paisa={row.balance} />
                  </span>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-2">
                  {row.saleId ? (
                    <Link
                      to="/sales/$id"
                      params={{ id: row.saleId }}
                      className="underline"
                    >
                      {rows[index]?.description}
                    </Link>
                  ) : (
                    rows[index]?.description
                  )}
                  {rows[index]?.voided ? (
                    <span className="rounded-full bg-danger-subtle px-2 text-caption font-medium text-danger-subtle-ink">
                      {t('office.udhaar.voided_bill')}
                    </span>
                  ) : null}
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <dt className="text-text-muted">
                      {t('office.udhaar.debit')}
                    </dt>
                    <dd className="text-start">
                      {row.debit > 0 ? <MoneyText paisa={row.debit} /> : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-muted">
                      {t('office.udhaar.credit')}
                    </dt>
                    <dd className="text-start">
                      {row.credit > 0 ? <MoneyText paisa={row.credit} /> : '—'}
                    </dd>
                  </div>
                </dl>
              </li>
            ))
          )}
        </ul>
      ) : null}

      {wide ? (
        <div
          ref={tableRef}
          className="max-h-[60vh] overflow-auto rounded-card border border-border"
        >
          <table className="w-full min-w-[34rem] text-small">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-border text-text-muted">
                <th className="p-2 text-start">{t('office.udhaar.date')}</th>
                <th className="p-2 text-start">
                  {t('office.udhaar.description')}
                </th>
                <th className="p-2 text-start">{t('office.udhaar.debit')}</th>
                <th className="p-2 text-start">{t('office.udhaar.credit')}</th>
                <th className="p-2 text-start">{t('office.udhaar.balance')}</th>
              </tr>
            </thead>
            <tbody>
              {shownOpening !== 0 ? (
                <tr className="border-b border-border">
                  <td className="p-2" />
                  <td className="p-2">{t('office.udhaar.entry_opening')}</td>
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
                    {t('office.udhaar.no_entries')}
                  </td>
                </tr>
              ) : (
                shownRows.map((row, index) => (
                  <tr
                    key={row.entry.id}
                    className="border-b border-border last:border-0"
                  >
                    <td className="p-2 whitespace-nowrap">
                      {rows[index]?.date}
                    </td>
                    <td className="p-2">
                      <span className="flex flex-wrap items-center gap-2">
                        {row.saleId ? (
                          <Link
                            to="/sales/$id"
                            params={{ id: row.saleId }}
                            className="underline"
                          >
                            {rows[index]?.description}
                          </Link>
                        ) : (
                          rows[index]?.description
                        )}
                        {rows[index]?.voided ? (
                          <span className="rounded-full bg-danger-subtle px-2 text-caption font-medium text-danger-subtle-ink">
                            {t('office.udhaar.voided_bill')}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="p-2 text-start">
                      {row.debit > 0 ? <MoneyText paisa={row.debit} /> : '—'}
                    </td>
                    <td className="p-2 text-start">
                      {row.credit > 0 ? <MoneyText paisa={row.credit} /> : '—'}
                    </td>
                    <td className="p-2 text-start font-medium">
                      <MoneyText paisa={row.balance} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {statement.hasMore ? (
        <button
          type="button"
          className={buttonQuiet}
          onClick={() => setVisibleRows((count) => count + STATEMENT_PAGE)}
        >
          {t('office.udhaar.show_older')}
        </button>
      ) : null}

      <p className="text-small text-text-muted">
        {t('office.udhaar.balance')}: <MoneyText paisa={balance} /> ·{' '}
        {dateText(today, i18n.language, tz)}
      </p>

      <ReceivePaymentDialog
        open={receiveOpen}
        onOpenChange={setReceiveOpen}
        customerId={customerId}
        customerName={name}
        balance={balance}
      />
      <PromiseDialog
        open={promiseOpen}
        onOpenChange={setPromiseOpen}
        customerId={customerId}
        customerName={name}
        balance={balance}
      />
      <CustomerDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        customer={customer}
      />
    </div>
  );
}
