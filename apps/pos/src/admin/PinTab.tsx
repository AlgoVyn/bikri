import { hashPin, isWeakPin, PIN_ITERATIONS } from '@bikri/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { adminErrorMessage, listOwners, resetOwnerPin } from './api.ts';
import { Field, primaryBtn } from './ui.tsx';
import { useAdminQuery } from './useAdminQuery.ts';

const inputClass =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 font-mono text-text';

export function PinTab({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const query = useAdminQuery(`owners:${tenantId}`, () => listOwners(tenantId));
  const [ownerId, setOwnerId] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const owners = query.data?.owners;

  useEffect(() => {
    if (owners === undefined) return;
    if (owners.some((owner) => owner.id === ownerId)) return;
    setOwnerId(owners[0]?.id ?? '');
  }, [owners, ownerId]);

  if (query.data === null) {
    return query.error !== null ? (
      <p className="text-text-muted">
        {query.error}{' '}
        <button type="button" className={primaryBtn} onClick={query.reload}>
          {t('admin.retry')}
        </button>
      </p>
    ) : (
      <p className="sr-only">{t('common.loading')}</p>
    );
  }
  if (query.data.owners.length === 0) {
    return <p className="text-text-muted">{t('admin.pin_empty')}</p>;
  }

  return (
    <form
      className="flex max-w-md flex-col gap-3 rounded-card border border-border bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || ownerId === '') return;
        if (pin !== again) {
          setFormError(t('admin.pin_mismatch'));
          return;
        }
        if (isWeakPin(pin)) {
          setFormError(t('admin.pin_weak'));
          return;
        }
        setFormError(null);
        setPending(true);
        // The PIN stays in this browser. Only the PBKDF2 hash is posted.
        void hashPin(pin, PIN_ITERATIONS)
          .then((hashed) =>
            resetOwnerPin(tenantId, {
              staff_id: ownerId,
              pin_hash: hashed.pin_hash,
              pin_salt: hashed.pin_salt,
              pin_iterations: hashed.pin_iterations,
            }),
          )
          .then(() => {
            setPin('');
            setAgain('');
            toast.push(t('admin.pin_done'), 'info');
          })
          .catch((err: unknown) => {
            toast.push(adminErrorMessage(err, t('admin.err_generic')), 'error');
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      <p className="text-text-muted">{t('admin.pin_reminder')}</p>
      <Field id="pin-owner" label={t('admin.pin_owner')}>
        <select
          id="pin-owner"
          className={inputClass}
          value={ownerId}
          onChange={(event) => {
            setOwnerId(event.target.value);
          }}
        >
          {query.data.owners.map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="pin-new" label={t('admin.pin_new')} hint={t('admin.pin_hint')}>
        <input
          id="pin-new"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          className={inputClass}
          value={pin}
          maxLength={6}
          aria-describedby="pin-new-hint"
          onChange={(event) => {
            setPin(event.target.value);
          }}
        />
      </Field>
      <Field id="pin-again" label={t('admin.pin_again')}>
        <input
          id="pin-again"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          className={inputClass}
          value={again}
          maxLength={6}
          onChange={(event) => {
            setAgain(event.target.value);
          }}
        />
      </Field>
      {formError !== null ? (
        <p className="text-small text-danger" role="alert">
          {formError}
        </p>
      ) : null}
      <button
        type="submit"
        className={primaryBtn}
        disabled={pending || ownerId === ''}
      >
        {t('admin.pin_reset')}
      </button>
    </form>
  );
}
