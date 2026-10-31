import { hashPin, isWeakPin, PIN_ITERATIONS } from '@bikri/core';
import {
  Box,
  Button,
  NativeSelect,
  PasswordInput,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { adminErrorMessage, listOwners, resetOwnerPin } from './api.ts';
import { Panel } from './ui.tsx';
import { useAdminQuery } from './useAdminQuery.ts';

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
      <Stack gap="sm" align="flex-start">
        <Text c="dimmed">{query.error}</Text>
        <Button type="button" onClick={query.reload}>
          {t('admin.retry')}
        </Button>
      </Stack>
    ) : (
      <Text className="sr-only">{t('common.loading')}</Text>
    );
  }
  if (query.data.owners.length === 0) {
    return <Text c="dimmed">{t('admin.pin_empty')}</Text>;
  }

  return (
    <Panel
      title={t('admin.tab_pin')}
      description={t('admin.pin_subtitle')}
      className="max-w-xl"
    >
      <Box
        component="form"
        onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
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
              toast.push(
                adminErrorMessage(err, t('admin.err_generic')),
                'error',
              );
            })
            .finally(() => {
              setPending(false);
            });
        }}
      >
        <Stack gap="md">
          <Text
            size="sm"
            p="sm"
            bg="var(--mantine-color-warning-subtle)"
            c="var(--mantine-color-warning-subtle-ink)"
          >
            {t('admin.pin_reminder')}
          </Text>
          <NativeSelect
            id="pin-owner"
            label={t('admin.pin_owner')}
            value={ownerId}
            onChange={(event) => setOwnerId(event.currentTarget.value)}
            data={query.data.owners.map((owner) => ({
              value: owner.id,
              label: owner.name,
            }))}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <PasswordInput
              id="pin-new"
              label={t('admin.pin_new')}
              description={t('admin.pin_hint')}
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              maxLength={6}
              aria-describedby="pin-new-hint"
              styles={{
                input: { fontFamily: 'var(--mantine-font-family-monospace)' },
              }}
              onChange={(event) => setPin(event.currentTarget.value)}
            />
            <PasswordInput
              id="pin-again"
              label={t('admin.pin_again')}
              inputMode="numeric"
              autoComplete="new-password"
              value={again}
              maxLength={6}
              styles={{
                input: { fontFamily: 'var(--mantine-font-family-monospace)' },
              }}
              onChange={(event) => setAgain(event.currentTarget.value)}
            />
          </SimpleGrid>
          {formError !== null ? (
            <Text size="sm" c="danger" role="alert">
              {formError}
            </Text>
          ) : null}
          <Box
            pt="md"
            style={{
              borderTop: '1px solid var(--mantine-color-default-border)',
            }}
          >
            <Button
              type="submit"
              disabled={pending || ownerId === ''}
              loading={pending}
            >
              {t('admin.pin_reset')}
            </Button>
          </Box>
        </Stack>
      </Box>
    </Panel>
  );
}
