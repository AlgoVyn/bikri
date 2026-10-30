import { businessDate } from '@bikri/core';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackLink } from '../components/BackLink.tsx';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyText } from '../components/MoneyText.tsx';
import { getDb } from '../data/db.ts';
import { shopTimeZone } from '../data/salesHistory.ts';
import {
  type ChaseRow,
  chaseCsv,
  chaseList,
  refreshPromises,
  reminderLink,
  reminderMessage,
} from '../data/udhaar.ts';
import { downloadText } from '../lib/download.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import {
  balanceLabel,
  balanceTone,
  dateText,
  groupLabel,
  timeText,
} from './format.ts';
import { PromiseDialog } from './PromiseDialog.tsx';
import { ReceivePaymentDialog } from './ReceivePaymentDialog.tsx';

/** Chase list (screens/12): promises due, then oldest unpaid age groups. */
export function ChaseList() {
  const { t, i18n } = useTranslation();
  const { can, staff } = useCurrentStaff();
  const canEditPromises = can('party.edit');
  const [selected, setSelected] = useState<ChaseRow | null>(null);
  const [dialog, setDialog] = useState<'promise' | 'receive' | null>(null);

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
    const shop = await db.shop.get('shop');
    return {
      ...(await chaseList(db, { today })),
      tz,
      today,
      shopName: String(shop?.name ?? ''),
    };
  }, []);

  const remind = (row: ChaseRow) => {
    if (!data) return;
    const link = reminderLink(
      String(row.customer.customer.phone ?? ''),
      reminderMessage(i18n.language as 'en' | 'ur' | 'roman-ur', {
        name: String(row.customer.customer.name),
        shop: data.shopName,
        balance: row.customer.balance,
        date: dateText(data.today, i18n.language, data.tz),
      }),
    );
    if (link) window.open(link, '_blank', 'noopener');
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <BackLink to="/udhaar" label={t('office.udhaar.back_customers')} />
        <h1 className="me-auto text-h1 font-semibold">
          {t('office.udhaar.chase_title')}
        </h1>
        {can('export.data') && data ? (
          <button
            type="button"
            className={buttonQuiet}
            onClick={() =>
              downloadText(
                'bikri-chase.csv',
                chaseCsv(data, (key) => groupLabel(t, key)),
              )
            }
          >
            {t('office.udhaar.export_csv')}
          </button>
        ) : null}
      </div>

      {data ? (
        <p
          data-testid="chase-total"
          className="rounded-card border border-border bg-surface p-3 text-small"
        >
          {t('office.udhaar.total_owed')}:{' '}
          <span className="text-title font-semibold">
            <MoneyText paisa={data.total} />
          </span>
        </p>
      ) : null}

      {data && data.groups.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-4 text-center text-text-muted">
          {t('office.udhaar.no_chase')}
        </p>
      ) : null}

      {data?.groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
            <h2 className="text-title font-semibold">
              {groupLabel(t, group.key)}
            </h2>
            <p className="text-small text-text-muted">
              <MoneyText paisa={group.total} />
            </p>
          </div>
          <ul className="flex flex-col rounded-card border border-border bg-surface">
            {group.rows.map((row) => (
              <li
                key={row.customer.customer.id}
                className="flex flex-wrap items-center gap-2 border-b border-border p-2 last:border-0"
              >
                <Link
                  to="/udhaar/$customerId"
                  params={{ customerId: row.customer.customer.id }}
                  className="min-w-0 flex-[2_1_12rem] hover:underline"
                >
                  <span className="block truncate font-medium">
                    {String(row.customer.customer.name)}
                  </span>
                  <span className="block text-small text-text-muted">
                    {t('office.udhaar.days_old', { days: row.ageDays })}
                    {row.lastPaymentAt
                      ? ` · ${timeText(row.lastPaymentAt, i18n.language, data.tz)}`
                      : ''}
                  </span>
                </Link>
                <span
                  className={`min-w-0 flex-[1_1_7rem] whitespace-nowrap text-end text-small font-medium max-sm:basis-full max-sm:text-start ${balanceTone(row.customer.balance)}`}
                >
                  {balanceLabel(t, row.customer.balance)}
                </span>
                <span className="grid w-full grid-cols-2 gap-1 sm:w-auto sm:grid-cols-4">
                  <button
                    type="button"
                    className={buttonQuiet}
                    disabled={!String(row.customer.customer.phone ?? '')}
                    onClick={() => remind(row)}
                  >
                    {t('office.udhaar.remind')}
                  </button>
                  {row.customer.customer.phone ? (
                    <a
                      className={buttonQuiet}
                      href={`tel:${String(row.customer.customer.phone)}`}
                    >
                      {t('office.udhaar.call')}
                    </a>
                  ) : null}
                  {can('party.edit') ? (
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() => {
                        setSelected(row);
                        setDialog('promise');
                      }}
                    >
                      {t('office.udhaar.promise')}
                    </button>
                  ) : null}
                  {can('payment.receive') ? (
                    <button
                      type="button"
                      className={buttonPrimary}
                      onClick={() => {
                        setSelected(row);
                        setDialog('receive');
                      }}
                    >
                      {t('office.udhaar.receive')}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {selected ? (
        <>
          <PromiseDialog
            open={dialog === 'promise'}
            onOpenChange={(open) => setDialog(open ? 'promise' : null)}
            customerId={selected.customer.customer.id}
            customerName={String(selected.customer.customer.name)}
            balance={selected.customer.balance}
          />
          <ReceivePaymentDialog
            open={dialog === 'receive'}
            onOpenChange={(open) => setDialog(open ? 'receive' : null)}
            customerId={selected.customer.customer.id}
            customerName={String(selected.customer.customer.name)}
            balance={selected.customer.balance}
          />
        </>
      ) : null}
    </div>
  );
}
