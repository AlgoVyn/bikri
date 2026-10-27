import type { MasterRow } from '@bikri/db';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { PhoneInput } from '../components/PhoneInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { createSupplier, updateSupplier } from '../data/suppliers.ts';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

/** New / edit supplier (screens/13). */
export function SupplierDialog({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier?: MasterRow | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const editing = supplier ?? null;
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [opening, setOpening] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing ? String(editing.name) : '');
    setPhone(editing ? String(editing.phone ?? '') : '');
    setAddress(editing ? String(editing.address ?? '') : '');
    setNote(editing ? String(editing.note ?? '') : '');
    setOpening(null);
    setPending(false);
  }, [open, editing]);

  const save = async () => {
    if (name.trim() === '' || pending) return;
    setPending(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, staff?.id ?? '');
      if (editing)
        await updateSupplier(
          db,
          editing.id,
          { name, phone, address, note },
          staff?.id ?? null,
        );
      else
        await createSupplier(
          db,
          { name, phone, address, note, opening: opening ?? 0 },
          ctx,
          staff?.id ?? null,
        );
      toast.push(
        editing
          ? t('office.suppliers.supplier_saved')
          : t('office.suppliers.supplier_added'),
      );
      onOpenChange(false);
    } catch (err) {
      toast.push(
        err instanceof Error ? err.message : t('errors.generic'),
        'error',
      );
    } finally {
      setPending(false);
    }
  };

  const field =
    'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={
        editing
          ? t('office.suppliers.edit_supplier')
          : t('office.suppliers.new_supplier')
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-small sm:col-span-2">
          {t('office.suppliers.name')}
          <input
            className={field}
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <PhoneInput
          label={t('office.suppliers.phone')}
          value={phone}
          onChange={(next) => setPhone(next ?? '')}
        />
        <label className="flex flex-col gap-1 text-small">
          {t('office.suppliers.address')}
          <input
            className={field}
            maxLength={120}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-small sm:col-span-2">
          {t('office.suppliers.note')}
          <input
            className={field}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {!editing ? (
          <MoneyInput
            label={t('office.suppliers.opening_balance')}
            value={opening}
            onChange={setOpening}
          />
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
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
          {t('office.suppliers.save')}
        </button>
      </div>
    </Modal>
  );
}
