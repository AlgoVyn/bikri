import {
  hashPin,
  isWeakPin,
  PERMISSIONS,
  type Permission,
  type Role,
  roleAllows,
} from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import {
  SettingsError,
  type StaffInput,
  saveStaff,
  staffList,
} from '../data/settings.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { Modal } from '../sell/Modal.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { SettingsGuard } from './Guard.tsx';
import { SettingsPageLayout } from './Layout.tsx';

const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';
const ROLES: Role[] = ['owner', 'manager', 'cashier'];

/** Cashiers, roles, PINs and permission overrides (screens/17). */
export function StaffSettingsPage() {
  return (
    <AreaStrings area="office">
      <SettingsGuard permission="settings.staff">
        <StaffList />
      </SettingsGuard>
    </AreaStrings>
  );
}

function StaffList() {
  const { t } = useTranslation();
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState<MasterRow | null>(null);
  const [adding, setAdding] = useState(false);
  const rows = useLiveQuery(() => staffList(getDb()), []) ?? [];
  return (
    <SettingsPageLayout title={t('office.staff.title')}>
      <div className="flex justify-end">
        <button
          type="button"
          className={buttonPrimary}
          disabled={readOnly}
          onClick={() => setAdding(true)}
        >
          {t('office.staff.add')}
        </button>
      </div>
      {rows.length === 0 ? (
        <EmptyState message={t('office.staff.empty')} />
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
          {rows.map((row) => (
            <li key={row.staff.id}>
              <button
                type="button"
                className="flex min-h-14 w-full flex-wrap items-center gap-2 p-3 text-start hover:bg-surface-2"
                disabled={readOnly}
                onClick={() => setEditing(row.staff)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {String(row.staff.name)}
                  </span>
                  <span className="text-small text-text-muted">
                    {t(`office.staff.role_${String(row.staff.role)}`)}
                    {' · '}
                    {row.staff.active === 1
                      ? t('office.staff.active')
                      : t('office.staff.inactive')}
                  </span>
                </span>
                {row.isLastOwner ? (
                  <span className="rounded-pill bg-primary-subtle px-2 py-0.5 text-small text-primary-subtle-ink">
                    {t('office.staff.last_owner')}
                  </span>
                ) : null}
                <span className="text-small text-text-muted">
                  {row.staff.pin_hash
                    ? t('office.staff.pin_set')
                    : t('office.staff.pin_not_set')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <StaffDialog
        open={adding || editing !== null}
        row={editing}
        isLastOwner={
          rows.find((row) => row.staff.id === editing?.id)?.isLastOwner ?? false
        }
        onOpenChange={(open) => {
          if (!open) {
            setAdding(false);
            setEditing(null);
          }
        }}
      />
    </SettingsPageLayout>
  );
}

function StaffDialog({
  open,
  row,
  isLastOwner,
  onOpenChange,
}: {
  open: boolean;
  row: MasterRow | null;
  isLastOwner: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff: actor } = useCurrentStaff();
  const readOnly = useReadOnly();
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('cashier');
  const [active, setActive] = useState(true);
  const [maxDiscountBp, setMaxDiscountBp] = useState(500);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(row ? String(row.name) : '');
    setRole((row?.role as Role | undefined) ?? 'cashier');
    setActive(row ? row.active === 1 : true);
    setMaxDiscountBp(Number(row?.max_discount_bp ?? 500));
    try {
      setOverrides(
        JSON.parse(String(row?.permissions_json ?? '{}')) as Record<
          string,
          boolean
        >,
      );
    } catch {
      setOverrides({});
    }
    setPin('');
    setPin2('');
    setPending(false);
  }, [open, row]);

  const checked = (permission: Permission): boolean =>
    overrides[permission] ?? roleAllows(role, permission);

  const toggle = (permission: Permission, value: boolean) => {
    setOverrides((current) => {
      const next = { ...current };
      if (value === roleAllows(role, permission)) delete next[permission];
      else next[permission] = value;
      return next;
    });
  };

  const save = async () => {
    if (pending) return;
    if (pin !== '' && (pin !== pin2 || isWeakPin(pin))) {
      toast.push(t('office.staff.pin_invalid'), 'error');
      return;
    }
    if (!row && pin === '') {
      toast.push(t('office.staff.pin_required'), 'error');
      return;
    }
    setPending(true);
    try {
      const pinHash = pin === '' ? undefined : await hashPin(pin);
      const input: StaffInput = {
        ...(row ? { id: String(row.id) } : {}),
        name,
        role,
        active,
        maxDiscountBp,
        permissions: overrides,
        ...(pinHash ? { pin: { ...pinHash, pin_length: pin.length } } : {}),
      };
      await saveStaff(getDb(), input, actor?.id ?? null);
      toast.push(t('office.staff.saved'));
      onOpenChange(false);
    } catch (err) {
      const code = err instanceof SettingsError ? err.code : 'generic';
      toast.push(
        code === 'generic'
          ? t('errors.generic')
          : t(`office.staff.error_${code}`),
        'error',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={row ? t('office.staff.edit') : t('office.staff.add')}
      wide
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-small">
          {t('office.staff.name')}
          <input
            className={field}
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.staff.role')}
          <select
            className={field}
            value={role}
            disabled={isLastOwner}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {ROLES.map((item) => (
              <option key={item} value={item}>
                {t(`office.staff.role_${item}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.staff.max_discount')}
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            className={field}
            value={maxDiscountBp / 100}
            onChange={(event) =>
              setMaxDiscountBp(
                Math.round(
                  Math.max(0, Math.min(100, Number(event.target.value) || 0)) *
                    100,
                ),
              )
            }
          />
        </label>
        <label className="flex items-center gap-2 self-end text-small">
          <input
            type="checkbox"
            checked={active}
            disabled={isLastOwner}
            onChange={(event) => setActive(event.target.checked)}
          />
          {t('office.staff.active')}
        </label>
        <label className="flex flex-col gap-1 text-small">
          {row ? t('office.staff.new_pin') : t('office.staff.pin')}
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            className={field}
            maxLength={6}
            value={pin}
            onChange={(event) =>
              setPin(event.target.value.replace(/[^0-9]/gu, ''))
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('office.staff.pin_again')}
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            className={field}
            maxLength={6}
            value={pin2}
            onChange={(event) =>
              setPin2(event.target.value.replace(/[^0-9]/gu, ''))
            }
          />
        </label>
      </div>
      {isLastOwner ? (
        <div className="flex flex-col gap-1 rounded-control bg-warning-subtle p-2 text-small text-warning-subtle-ink">
          <p className="font-medium">{t('office.staff.last_owner')}</p>
          <p>{t('office.staff.last_owner_hint')}</p>
        </div>
      ) : null}
      <fieldset>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <legend className="text-small">
            {t('office.staff.permissions')}
          </legend>
          <button
            type="button"
            className="text-small underline"
            onClick={() => setOverrides({})}
          >
            {t('office.staff.reset_permissions')}
          </button>
        </div>
        <ul className="grid max-h-64 gap-1 overflow-y-auto rounded-control border border-border p-2 sm:grid-cols-2">
          {PERMISSIONS.map((permission) => (
            <li key={permission}>
              <label className="flex items-center gap-2 text-small">
                <input
                  type="checkbox"
                  checked={checked(permission)}
                  onChange={(event) => toggle(permission, event.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  {t(`office.staff.perm_${permission.replaceAll('.', '_')}`)}
                </span>
                {overrides[permission] !== undefined ? (
                  <span className="text-text-muted">
                    {t('office.staff.override')}
                  </span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
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
          disabled={pending || name.trim() === '' || readOnly}
          onClick={() => void save()}
        >
          {t('office.staff.save')}
        </button>
      </div>
    </Modal>
  );
}
