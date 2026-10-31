import { Button, Group, NativeSelect, PasswordInput } from '@mantine/core';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../sell/Modal.tsx';

const PIN_PATTERN = /^\d{4,6}$/u;

export type OverrideProfile = {
  id: string;
  label: string;
};

/** Manager/owner PIN approval for a below-cost sale or an over-limit action. */
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
  /** Checks the PIN of the chosen approver (profile id; '' when there are no profiles). */
  verify: (pin: string, profileId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const pinId = useId();
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
      const accepted = await verify(pin, profileIdValue);
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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={titleText}
      description={bodyText}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => void onSubmit(event)}
      >
        {choices.length > 0 ? (
          <NativeSelect
            id={profileId}
            label={t('ui.override_profile')}
            value={profileIdValue}
            onChange={(event) => setProfileIdValue(event.currentTarget.value)}
            data={choices.map((profile) => ({
              value: profile.id,
              label: profile.label,
            }))}
          />
        ) : null}
        <PasswordInput
          id={pinId}
          label={t('ui.override_pin')}
          data-autofocus
          inputMode="numeric"
          autoComplete="off"
          dir="ltr"
          maxLength={6}
          value={pin}
          error={error}
          onChange={(event) =>
            setPin(event.currentTarget.value.replace(/\D/gu, '').slice(0, 6))
          }
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={pending}>
            {t('ui.override_submit')}
          </Button>
        </Group>
      </form>
    </Modal>
  );
}
