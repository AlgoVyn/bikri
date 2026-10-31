import {
  Box,
  Button,
  Group,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StoreIcon } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import { adminErrorMessage, createTenant, slugAvailable } from './api.ts';
import {
  adminHref,
  DEFAULT_WRITE_BUDGET,
  EMAIL_RE,
  SLUG_RE,
} from './format.ts';
import type { IssuedCode } from './types.ts';
import { PairingPanel, Panel } from './ui.tsx';

type SlugState = 'idle' | 'checking' | 'free' | 'taken' | 'invalid';

const STEPS = [
  'admin.new_side_1',
  'admin.new_side_2',
  'admin.new_side_3',
  'admin.new_side_4',
] as const;

export function NewShopPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [budget, setBudget] = useState(String(DEFAULT_WRITE_BUDGET));
  const [note, setNote] = useState('');
  const [slugState, setSlugState] = useState<SlugState>('idle');
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<{
    code: IssuedCode;
    shop: string;
    tenantId: string;
  } | null>(null);

  useEffect(() => {
    if (!SLUG_RE.test(slug)) {
      setSlugState(slug === '' ? 'idle' : 'invalid');
      return;
    }
    setSlugState('checking');
    let cancelled = false;
    const handle = setTimeout(() => {
      void slugAvailable(slug)
        .then((result) => {
          if (!cancelled) setSlugState(result.available ? 'free' : 'taken');
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSlugState('invalid');
          toast.push(adminErrorMessage(err, t('admin.err_generic')), 'error');
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [slug, t, toast]);

  const budgetN = Number(budget);
  const budgetOk =
    Number.isInteger(budgetN) && budgetN >= 0 && budgetN <= 100_000;
  const emailOk =
    email.trim() === '' || EMAIL_RE.test(email.trim().toLowerCase());
  const nameOk = name.trim().length >= 1 && name.trim().length <= 60;
  const canCreate =
    nameOk && slugState === 'free' && emailOk && budgetOk && note.length <= 500;

  if (issued !== null) {
    return (
      <Stack gap="lg">
        <PageHeader
          icon={<StoreIcon />}
          title={issued.shop}
          subtitle={t('admin.created_hint')}
          actions={
            <Button
              component="a"
              href={adminHref(`/admin/tenants/${issued.tenantId}`)}
            >
              {t('admin.open_shop')}
            </Button>
          }
        />
        <SimpleGrid
          cols={{ base: 1, xl: 2 }}
          spacing="md"
          style={{ alignItems: 'start' }}
        >
          <PairingPanel
            code={issued.code.code}
            link={issued.code.link}
            expiresAt={issued.code.expires_at}
            shopName={issued.shop}
          />
          <Panel title={t('admin.new_side_title')}>
            <Stack gap="sm">
              {STEPS.map((key, index) => (
                <Group key={key} gap="sm" align="flex-start" wrap="nowrap">
                  <ThemeIcon
                    size={24}
                    radius="xl"
                    variant="light"
                    color="brand"
                  >
                    <Text size="xs" fw={600}>
                      {index + 1}
                    </Text>
                  </ThemeIcon>
                  <Text size="sm">{t(key)}</Text>
                </Group>
              ))}
            </Stack>
          </Panel>
        </SimpleGrid>
        <Button
          component="a"
          href={adminHref('/admin/tenants')}
          variant="default"
          style={{ alignSelf: 'flex-start' }}
        >
          {t('admin.back_to_shops')}
        </Button>
      </Stack>
    );
  }

  return (
    <Box
      component="form"
      onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!canCreate || pending) return;
        setPending(true);
        const display = name.trim();
        void createTenant({
          slug,
          display_name: display,
          daily_write_budget: budgetN,
          note,
          ...(email.trim() === ''
            ? {}
            : { owner_email: email.trim().toLowerCase() }),
        })
          .then((result) => {
            setIssued({
              code: result.owner_code,
              shop: display,
              tenantId: result.tenant.id,
            });
          })
          .catch((err: unknown) => {
            toast.push(adminErrorMessage(err, t('admin.err_generic')), 'error');
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      <PageHeader
        icon={<StoreIcon />}
        title={t('admin.new_title')}
        subtitle={t('admin.new_subtitle')}
        actions={
          <Button
            component="a"
            href={adminHref('/admin/tenants')}
            variant="default"
          >
            {t('admin.back_to_shops')}
          </Button>
        }
      />
      <SimpleGrid
        cols={{ base: 1, xl: 2 }}
        spacing="md"
        style={{ alignItems: 'start' }}
      >
        <Panel
          title={t('admin.new_details')}
          description={t('admin.new_details_hint')}
        >
          <Stack gap="md">
            <TextInput
              id="shop-name"
              label={t('admin.display_name')}
              value={name}
              maxLength={60}
              required
              autoComplete="off"
              onChange={(event) => {
                setName(event.currentTarget.value);
              }}
            />
            <Box>
              <TextInput
                id="shop-slug"
                label={t('admin.slug')}
                description={t('admin.slug_hint')}
                value={slug}
                maxLength={30}
                required
                autoComplete="off"
                spellCheck={false}
                aria-describedby="shop-slug-hint"
                styles={{
                  input: { fontFamily: 'var(--mantine-font-family-monospace)' },
                }}
                onChange={(event) => {
                  setSlug(event.currentTarget.value.trim().toLowerCase());
                }}
              />
              <Text aria-live="polite" size="sm" mt={4}>
                {slugState === 'checking' ? (
                  <span className="text-text-muted">
                    {t('admin.slug_checking')}
                  </span>
                ) : null}
                {slugState === 'free' ? (
                  <span className="text-success-subtle-ink">
                    {t('admin.slug_free')}
                  </span>
                ) : null}
                {slugState === 'taken' ? (
                  <span className="text-danger">{t('admin.slug_taken')}</span>
                ) : null}
                {slugState === 'invalid' ? (
                  <span className="text-danger">{t('admin.slug_invalid')}</span>
                ) : null}
              </Text>
            </Box>
            <TextInput
              id="shop-email"
              type="email"
              label={t('admin.owner_email')}
              description={t('admin.owner_email_hint')}
              value={email}
              maxLength={254}
              autoComplete="off"
              aria-describedby="shop-email-hint"
              onChange={(event) => {
                setEmail(event.currentTarget.value);
              }}
            />
            <TextInput
              id="shop-budget"
              label={t('admin.budget')}
              inputMode="numeric"
              value={budget}
              styles={{
                input: { fontFamily: 'var(--mantine-font-family-monospace)' },
              }}
              onChange={(event) => {
                setBudget(event.currentTarget.value);
              }}
            />
            <Box>
              <Textarea
                id="shop-note"
                label={t('admin.note')}
                minRows={3}
                maxLength={500}
                value={note}
                onChange={(event) => {
                  setNote(event.currentTarget.value);
                }}
              />
              <Text size="sm" c="dimmed" ta="end" mt={4}>
                {note.length} / 500
              </Text>
            </Box>
          </Stack>
          {!budgetOk ? (
            <Text mt="sm" size="sm" c="danger" role="alert">
              {t('admin.err_budget')}
            </Text>
          ) : null}
          <Group
            justify="flex-end"
            gap="sm"
            mt="md"
            pt="md"
            style={{
              borderTop: '1px solid var(--mantine-color-default-border)',
            }}
          >
            <Button
              component="a"
              href={adminHref('/admin/tenants')}
              variant="default"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={!canCreate || pending}
              loading={pending}
            >
              {t('admin.create')}
            </Button>
          </Group>
        </Panel>

        <Panel title={t('admin.new_side_title')}>
          <Stack gap="sm">
            {STEPS.map((key, index) => (
              <Group key={key} gap="sm" align="flex-start" wrap="nowrap">
                <ThemeIcon size={24} radius="xl" variant="light" color="brand">
                  <Text size="xs" fw={600}>
                    {index + 1}
                  </Text>
                </ThemeIcon>
                <Text size="sm">{t(key)}</Text>
              </Group>
            ))}
          </Stack>
        </Panel>
      </SimpleGrid>
    </Box>
  );
}
