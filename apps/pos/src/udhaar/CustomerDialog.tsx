import type { MasterRow } from '@bikri/db';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
} from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { PhoneInput } from '../components/PhoneInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import {
  CustomerBalanceError,
  createCustomerAccount,
  customerBalance,
  DuplicatePhoneError,
  deleteCustomer,
  updateCustomer,
} from '../data/customers.ts';
import { getDb } from '../data/db.ts';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

type Duplicate = { id: string; name: string };

/** New / edit customer (screens/12). */
export function CustomerDialog({
  open,
  onOpenChange,
  customer,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer?: MasterRow | null;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff, role, can } = useCurrentStaff();
  const editing = customer ?? null;
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [limit, setLimit] = useState<number | null>(null);
  const [hard, setHard] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(false);
  const balance = useLiveQuery(
    () => (editing ? customerBalance(getDb(), editing.id) : 0),
    [editing?.id],
  );

  useEffect(() => {
    if (!open) return;
    setName(editing ? String(editing.name) : '');
    setPhone(editing ? String(editing.phone ?? '') : '');
    setAddress(editing ? String(editing.address ?? '') : '');
    setNote(editing ? String(editing.note ?? '') : '');
    setLimit(
      editing &&
        editing.credit_limit !== null &&
        editing.credit_limit !== undefined
        ? Number(editing.credit_limit)
        : null,
    );
    setHard(Number(editing?.hard_limit ?? 0) === 1);
    setOpening(null);
    setDuplicate(null);
    setPending(false);
  }, [open, editing]);

  const save = async () => {
    if (name.trim() === '' || pending) return;
    setPending(true);
    setDuplicate(null);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      const fields = {
        name,
        phone,
        address,
        note,
        // 05 §6: cashiers may create a customer but never set or change a credit limit.
        credit_limit: role === 'cashier' ? null : limit,
        hard_limit: role === 'owner' ? hard : false,
      };
      if (editing) await updateCustomer(db, editing.id, fields, ctx);
      else
        await createCustomerAccount(
          db,
          { ...fields, opening: opening ?? 0 },
          ctx,
          staff?.id ?? null,
        );
      toast.push(
        editing
          ? t('office.udhaar.customer_saved')
          : t('office.udhaar.customer_added'),
      );
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof DuplicatePhoneError)
        setDuplicate({ id: err.ownerId, name: err.ownerName });
      else
        toast.push(
          err instanceof Error ? err.message : t('errors.generic'),
          'error',
        );
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    try {
      const db = getDb();
      await deleteCustomer(db, editing.id, staff?.id ?? null);
      toast.push(t('office.udhaar.customer_deleted'));
      onOpenChange(false);
    } catch (err) {
      toast.push(
        err instanceof CustomerBalanceError
          ? t('office.udhaar.delete_balance')
          : t('errors.generic'),
        'error',
      );
    }
  };

  const canDelete =
    editing !== null && can('party.delete') && (balance ?? 0) === 0;

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={
          editing
            ? t('office.udhaar.edit_customer')
            : t('office.udhaar.new_customer')
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-small sm:col-span-2">
            {t('office.udhaar.name')}
            <input
              className="h-11 rounded-control border border-border-strong bg-surface px-3"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <PhoneInput
            label={t('office.udhaar.phone')}
            value={phone}
            onChange={(next) => setPhone(next ?? '')}
          />
          <label className="flex flex-col gap-1 text-small">
            {t('office.udhaar.address')}
            <input
              className="h-11 rounded-control border border-border-strong bg-surface px-3"
              value={address}
              maxLength={120}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-small sm:col-span-2">
            {t('office.udhaar.note')}
            <input
              className="h-11 rounded-control border border-border-strong bg-surface px-3"
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {role !== 'cashier' ? (
            <MoneyInput
              label={t('office.udhaar.credit_limit')}
              value={limit}
              onChange={setLimit}
            />
          ) : null}
          {role === 'owner' ? (
            <label className="flex min-h-11 items-center gap-2 self-end text-small">
              <input
                type="checkbox"
                checked={hard}
                onChange={(e) => setHard(e.target.checked)}
              />
              {t('office.udhaar.hard_limit')}
            </label>
          ) : null}
          {!editing ? (
            <MoneyInput
              label={t('office.udhaar.opening_balance')}
              value={opening}
              onChange={setOpening}
            />
          ) : null}
        </div>
        <p className="text-small text-text-muted">
          {t('office.udhaar.credit_hint')}
        </p>
        {duplicate ? (
          <p
            role="alert"
            className="rounded-control bg-warning-subtle p-2 text-small text-warning-subtle-ink"
          >
            {t('office.udhaar.duplicate_phone', { name: duplicate.name })}{' '}
            <Link
              to="/udhaar/$customerId"
              params={{ customerId: duplicate.id }}
              className="underline"
            >
              {t('office.udhaar.open_existing')}
            </Link>
          </p>
        ) : null}
        <div className="flex flex-wrap justify-between gap-2">
          <span>
            {canDelete ? (
              <button
                type="button"
                className={buttonDanger}
                onClick={() => setConfirmDelete(true)}
              >
                {t('office.udhaar.delete')}
              </button>
            ) : null}
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className={buttonPrimary}
              disabled={name.trim() === '' || pending}
              onClick={() => void save()}
            >
              {t('office.udhaar.save')}
            </button>
          </span>
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('office.udhaar.delete_title', { name: editing?.name ?? '' })}
        body={t('office.udhaar.delete_body')}
        confirmLabel={t('office.udhaar.delete')}
        onConfirm={() => void remove()}
      />
    </>
  );
}
