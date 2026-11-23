import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { useToast } from '../components/Toast.tsx';
import { useSubmitGuard } from '../components/useSubmitGuard.ts';
import { getDb } from '../data/db.ts';
import { createExpenseCategory } from '../data/expenses.ts';
import { ReadOnlyError } from '../data/write.ts';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

/** Owner-only `+ Category` for expenses (screens/14). */
export function CategoryDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const submitGuard = useSubmitGuard();
  const [name, setName] = useState('');
  const [nameUr, setNameUr] = useState('');
  const [pending, setPending] = useState(false);
  // The owning screen keeps this dialog mounted; clear the previous draft on reopen.
  useEffect(() => {
    if (!open) return;
    setName('');
    setNameUr('');
    setPending(false);
  }, [open]);
  const field =
    'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';

  const save = async () => {
    if (name.trim() === '' || pending) return;
    if (!submitGuard.lock()) return;
    setPending(true);
    try {
      await createExpenseCategory(getDb(), { name, nameUr }, staff?.id ?? null);
      toast.push(t('office.expenses.category_saved'));
      onSaved?.();
      setName('');
      setNameUr('');
      onOpenChange(false);
    } catch (err) {
      toast.push(
        err instanceof ReadOnlyError
          ? t('tenant.readOnly.blocked')
          : err instanceof RangeError && err.message === 'category exists'
            ? t('office.expenses.category_exists')
            : t('errors.generic'),
        'error',
      );
    } finally {
      submitGuard.unlock();
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('office.expenses.category_add')}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-small">
          {t('office.expenses.category_name')}
          <input
            className={field}
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.expenses.category_name_ur')}
          <input
            className={field}
            maxLength={40}
            dir="rtl"
            lang="ur"
            value={nameUr}
            onChange={(e) => setNameUr(e.target.value)}
          />
        </label>
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
          {t('office.expenses.save')}
        </button>
      </div>
    </Modal>
  );
}
