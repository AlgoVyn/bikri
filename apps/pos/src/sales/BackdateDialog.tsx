import type { MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
import { PastDatePicker } from '../components/PastDatePicker.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  BACKDATE_REASON_MAX,
  BackdateError,
  isBusinessDate,
  startBackdate,
} from '../data/backdate.ts';
import { type CartId, CartNotEmptyError } from '../data/cart.ts';
import { getDb } from '../data/db.ts';
import { useBusinessDates } from '../data/useBusinessDates.ts';
import { useShopTimeZone } from '../data/useShopTimeZone.ts';
import { ReadOnlyError } from '../data/write.ts';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';

const roleOrder: Record<string, number> = { owner: 0, manager: 1, cashier: 2 };

/** "Record a past sale": date, attributed cashier and reason (screens/10, D-173). */
export function BackdateDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (cartId: CartId) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const timeZone = useShopTimeZone();
  const { today } = useBusinessDates(timeZone);
  const [date, setDate] = useState(today);
  const [staffId, setStaffId] = useState(staff?.id ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const people = useLiveQuery(async () => {
    const rows = (await getDb().staff.toArray()).filter(
      (row) => row.active === 1 && !row.deleted_at,
    );
    return rows.sort(
      (a, b) =>
        (roleOrder[String(a.role)] ?? 9) - (roleOrder[String(b.role)] ?? 9) ||
        String(a.name).localeCompare(String(b.name)),
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    setDate(today);
    setStaffId(staff?.id ?? '');
    setReason('');
    setBusy(false);
  }, [open, today, staff?.id]);

  const valid =
    isBusinessDate(date) &&
    date <= today &&
    staffId !== '' &&
    reason.trim().length > 0 &&
    reason.trim().length <= BACKDATE_REASON_MAX;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const { cartId } = await startBackdate(getDb(), {
        actorId: staff?.id ?? '',
        date,
        staffId,
        reason,
      });
      onOpenChange(false);
      onStarted(cartId);
    } catch (err) {
      const key =
        err instanceof ReadOnlyError
          ? 'tenant.readOnly.blocked'
          : err instanceof CartNotEmptyError
            ? 'sell.no_free_cart'
            : err instanceof BackdateError
              ? `office.backdate.error_${err.code}`
              : 'office.backdate.error_generic';
      toast.push(t(key), 'error');
    } finally {
      setBusy(false);
    }
  };

  const staffName = useMemo(
    () => String(people?.find((p: MasterRow) => p.id === staffId)?.name ?? ''),
    [people, staffId],
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('office.backdate.title')}
      description={t('office.backdate.subtitle')}
      sheet
    >
      <div className="flex flex-col gap-3">
        <PastDatePicker
          label={t('office.backdate.date')}
          hint={t('office.backdate.date_hint')}
          value={date}
          today={today}
          onChange={setDate}
        />
        <label className="flex flex-col gap-1 text-small">
          <span>{t('office.backdate.staff')}</span>
          <select
            className={fieldClass}
            data-testid="backdate-staff"
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
          >
            <option value="">{t('office.backdate.staff_placeholder')}</option>
            {(people ?? []).map((person: MasterRow) => (
              <option key={person.id} value={person.id}>
                {String(person.name)} ·{' '}
                {t(`office.backdate.role_${String(person.role)}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-small">
          <span>{t('office.backdate.reason')}</span>
          <textarea
            className={`${fieldClass} min-h-20 resize-y`}
            data-testid="backdate-reason"
            maxLength={BACKDATE_REASON_MAX}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('office.backdate.reason_placeholder')}
          />
        </label>
        <p className="rounded-control border border-warning bg-warning-subtle p-2 text-small text-warning-subtle-ink">
          {t('office.backdate.warning', { staff: staffName || '—' })}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
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
            data-testid="backdate-start"
            disabled={!valid || busy}
            onClick={() => void submit()}
          >
            {t('office.backdate.start')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
