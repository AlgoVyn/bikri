import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet, fieldClass } from './classes.ts';

const overlayClass = 'fixed inset-0 z-40 bg-text/40';
const contentClass =
  'fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(28rem,calc(100%-2rem))] flex-col gap-4 rounded-modal bg-surface p-4 text-text shadow-modal';

const PIN_PATTERN = /^\d{4,6}$/u;

export type OverrideProfile = {
  id: string;
  label: string;
};

export function OverrideDialog({
  open,
  onOpenChange,
  title,
  body,
  profiles,
  verify,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  body?: string;
  profiles?: readonly OverrideProfile[];
  verify: (pin: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const pinId = useId();
  const errorId = useId();
  const profileId = useId();
  const [pin, setPin] = useState('');
  const [profileIdValue, setProfileIdValue] = useState(profiles?.[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const titleText = title ?? t('ui.override_title');
  const bodyText = body ?? t('ui.override_body');
  const choices = profiles ?? [];
  const firstProfile = choices[0]?.id ?? '';

  useEffect(() => {
    if (!open) {
      setPin('');
      setError(null);
      setPending(false);
      return;
    }
    setProfileIdValue(firstProfile);
  }, [open, firstProfile]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!PIN_PATTERN.test(pin)) {
      setError(t('errors.pin_required'));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const accepted = await verify(pin);
      if (!accepted) {
        setError(t('errors.pin_invalid'));
        return;
      }
      onOpenChange(false);
    } catch {
      setError(t('errors.pin_invalid'));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content className={contentClass}>
          <Dialog.Title className="text-title">{titleText}</Dialog.Title>
          <Dialog.Description>{bodyText}</Dialog.Description>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => void onSubmit(event)}
          >
            {choices.length > 0 ? (
              <div>
                <label
                  htmlFor={profileId}
                  className="mb-1 block text-small text-text"
                >
                  {t('ui.override_profile')}
                </label>
                <select
                  id={profileId}
                  className={fieldClass}
                  value={profileIdValue}
                  onChange={(event) => {
                    setProfileIdValue(event.target.value);
                  }}
                >
                  {choices.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div>
              <label
                htmlFor={pinId}
                className="mb-1 block text-small text-text"
              >
                {t('ui.override_pin')}
              </label>
              <input
                id={pinId}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                dir="ltr"
                maxLength={6}
                className={fieldClass}
                value={pin}
                aria-invalid={error !== null || undefined}
                aria-describedby={error !== null ? errorId : undefined}
                onChange={(event) => {
                  setPin(event.target.value.replace(/\D/gu, '').slice(0, 6));
                }}
              />
              {error !== null ? (
                <p id={errorId} className="mt-1 text-small text-danger">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className={buttonQuiet}>
                  {t('common.cancel')}
                </button>
              </Dialog.Close>
              <button
                type="submit"
                className={buttonPrimary}
                disabled={pending}
              >
                {t('ui.override_submit')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
