import { businessDate } from '@bikri/core';
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
import { shopTimeZone } from '../data/salesHistory.ts';
import {
  customerStatement,
  refreshPromises,
  reminderLink,
  reminderMessage,
  statementCsv,
} from '../data/udhaar.ts';
import { downloadText } from '../lib/download.ts';
import { downloadBlob } from '../print/receiptImage.ts';
import { printImageViaSystem } from '../print/systemPrint.ts';
import { useSellStore } from '../sell/sellStore.ts';
import { plainKey, useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { CustomerDialog } from './CustomerDialog.tsx';
import {
  ageLabel,
  balanceTone,
  dateText,
  entryDescription,
  limitPercent,
} from './format.ts';
import { PromiseDialog } from './PromiseDialog.tsx';
import { ReceivePaymentDialog } from './ReceivePaymentDialog.tsx';
import { statementPdf, statementPng } from './statementFile.ts';

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
  const tableRef = useRef<HTMLDivElement>(null);

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

  const data = useLiveQuery(async () => {
    const db = getDb();
    const customer = await db.customers.get(customerId);
    if (!customer) return null;
    const tz = await shopTimeZone(db);
    const today = businessDate(Date.now(), tz);
    const statement = await customerStatement(
      db,
      customerId,
      from || to
        ? { from: from || '0000-01-01', to: to || '9999-12-31' }
        : undefined,
    );
    const balance = (await db.party_balances.get(['customer', customerId]))
      ?.balance;
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
      balance: balance ?? statement.balance,
      oldest: (await db.party_balances.get(['customer', customerId]))
        ?.oldest_unpaid_at,
      promise: promise ?? null,
      shopName: String(shop?.name ?? ''),
    };
  }, [customerId, from, to]);

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

  const { customer, statement, tz, today, balance, shopName } = data;
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
  const rows = statement.rows.map((row) => ({
    date: dateText(String(row.entry.business_date), i18n.language, tz),
    description: entryDescription(t, row),
    debit: row.debit,
    credit: row.credit,
    balance: row.balance,
  }));
  const meta = {
    shopName,
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
      date: t('office.udhaar.date'),
      description: t('office.udhaar.description'),
      debit: t('office.udhaar.debit'),
      credit: t('office.udhaar.credit'),
      balance: t('office.udhaar.balance'),
      opening: t('office.udhaar.entry_opening'),
      total: t('office.udhaar.total'),
      asOf: t('office.udhaar.as_of', {
        date: dateText(today, i18n.language, tz),
      }),
    },
  };

  const exportCsv = () => {
    downloadText(
      `statement-${name.replace(/\s+/gu, '-')}.csv`,
      statementCsv(rows),
    );
  };
  const exportPdf = async () => {
    downloadBlob(
      await statementPdf(meta),
      `statement-${name.replace(/\s+/gu, '-')}.pdf`,
    );
  };
  const printStatement = async () => {
    const result = await printImageViaSystem(await statementPng(meta));
    if (!result.ok) toast.push(t('errors.generic'), 'error');
  };
  const share = async () => {
    try {
      const png = await statementPng(meta);
      const file = new File([png], `statement-${name}.png`, {
        type: 'image/png',
      });
      // With a phone, hand the picture to WhatsApp the same way the reminder does.
      if (reminder) {
        downloadBlob(png, file.name);
        window.open(reminder, '_blank', 'noopener');
        toast.push(t('done.image_saved'));
      } else if (navigator.canShare?.({ files: [file] }))
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
                  className={`${buttonPrimary} max-md:w-full`}
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
                  <ExportMenu
                    onCsv={exportCsv}
                    onPdf={() => void exportPdf()}
                    onShare={() => void share()}
                    onPrint={() => void printStatement()}
                  />
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
              ...(can('sale.create')
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
      </div>

      <ul className="flex flex-col gap-2 sm:hidden">
        {statement.openingBalance !== 0 ? (
          <li className="flex items-center justify-between gap-2 rounded-card border border-border bg-surface p-3 text-small">
            <span>{t('office.udhaar.entry_opening')}</span>
            <span className="font-medium">
              <MoneyText paisa={statement.openingBalance} />
            </span>
          </li>
        ) : null}
        {rows.length === 0 ? (
          <li className="rounded-card border border-border bg-surface p-4 text-center text-text-muted">
            {t('office.udhaar.no_entries')}
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

      <div
        ref={tableRef}
        className="hidden max-h-[60vh] overflow-auto rounded-card border border-border sm:block"
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
            {statement.openingBalance !== 0 ? (
              <tr className="border-b border-border">
                <td className="p-2" />
                <td className="p-2">{t('office.udhaar.entry_opening')}</td>
                <td className="p-2" />
                <td className="p-2" />
                <td className="p-2 text-start">
                  <MoneyText paisa={statement.openingBalance} />
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
