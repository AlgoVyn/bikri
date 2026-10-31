import {
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { Link, useLocation } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ClockIcon,
  CloudIcon,
  DeviceIcon,
  InfoIcon,
  PrinterIcon,
  SettingsIcon,
  StoreIcon,
  TagIcon,
  UsersIcon,
} from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { getDb } from '../data/db.ts';
import { deviceInfo, tenantInfo } from '../data/localTenant.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { rememberListScroll } from '../lib/listScroll.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

const _rowLink = 'flex min-h-14 items-center gap-3 p-3';

/** The shared Settings index: groups, this-device card and leave action. */
export function SettingsNav() {
  return (
    <AreaStrings area="office">
      <SettingsNavContent />
    </AreaStrings>
  );
}

function SettingsNavContent() {
  const { t } = useTranslation();
  const { role, can, support } = useCurrentStaff();
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const info = useLiveQuery(async () => {
    const db = getDb();
    return {
      device: await deviceInfo(db),
      tenant: await tenantInfo(db),
      enrolled: Boolean((await db.kv.get('device_token'))?.value),
    };
  }, []);
  const owner = role === 'owner';
  const leave = async () => {
    setLeaveError(null);
    if (
      !window.confirm(
        t('enrol.leave_confirm', { shop: info?.tenant?.display_name ?? '' }),
      )
    )
      return;
    const db = getDb();
    const { leaveShop, UnsyncedOpsError } = await import('../data/enrol.ts');
    try {
      await leaveShop(db);
      window.location.assign(`${import.meta.env.BASE_URL || '/'}enrol`);
    } catch (e) {
      setLeaveError(
        e instanceof UnsyncedOpsError
          ? t('enrol.leave_blocked', { count: e.count })
          : String(e),
      );
    }
  };
  return (
    <Stack gap="lg">
      <PageHeader
        icon={<SettingsIcon />}
        tone="bg-surface-2 text-text-muted"
        title={t('nav.settings')}
        subtitle={t('office.settings.subtitle')}
      />
      <nav aria-label={t('nav.settings')}>
        <Stack gap="lg">
          {can('settings.shop') ? (
            <SettingsGroup title={t('office.settings.nav_group_shop')}>
              <SettingsRow
                to="/settings/shop"
                icon={<StoreIcon />}
                title={t('office.settings.nav_shop')}
                hint={t('office.settings.nav_shop_hint')}
              />
              {can('settings.staff') ? (
                <SettingsRow
                  to="/settings/cashiers"
                  icon={<UsersIcon />}
                  title={t('office.settings.nav_cashiers')}
                  hint={t('office.settings.nav_cashiers_hint')}
                />
              ) : null}
              <SettingsRow
                to="/settings/activity"
                icon={<ClockIcon />}
                title={t('office.settings.nav_activity')}
                hint={t('office.settings.nav_activity_hint')}
              />
            </SettingsGroup>
          ) : null}
          <SettingsGroup title={t('office.settings.nav_group_device')}>
            <SettingsRow
              to="/settings/printer"
              icon={<PrinterIcon />}
              title={t('printer.title')}
              hint={t('office.settings.nav_printer_hint')}
            />
            {can('catalog.edit') ? (
              <SettingsRow
                to="/settings/labels"
                icon={<TagIcon />}
                title={t('office.settings.nav_labels')}
                hint={t('office.settings.nav_labels_hint')}
              />
            ) : null}
            <SettingsRow
              to="/settings/display"
              icon={<SettingsIcon />}
              title={t('office.settings.nav_display')}
              hint={t('office.settings.nav_display_hint')}
            />
          </SettingsGroup>
          <SettingsGroup title={t('office.settings.nav_group_data')}>
            <SettingsRow
              to="/settings/sync"
              icon={<CloudIcon />}
              title={t('syncpage.title')}
              hint={t('office.settings.nav_sync_hint')}
            />
            {support || (owner && info?.device?.is_admin && info.enrolled) ? (
              <SettingsRow
                to="/settings/devices"
                icon={<DeviceIcon />}
                title={t('devices.title')}
                hint={t('office.settings.nav_devices_hint')}
              />
            ) : null}
            {can('export.data') && role === 'owner' ? (
              <SettingsRow
                to="/settings/backup"
                icon={<CloudIcon />}
                title={t('office.backup.title')}
                hint={t('office.backup.nav_hint')}
              />
            ) : null}
            <SettingsRow
              to="/settings/about"
              icon={<InfoIcon />}
              title={t('office.settings.nav_about')}
              hint={t('office.settings.nav_about_hint')}
            />
          </SettingsGroup>
        </Stack>
      </nav>
      {info?.device ? (
        <Paper p="md" withBorder>
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <ThemeIcon size={36} radius="md" variant="light" color="gray">
              <DeviceIcon />
            </ThemeIcon>
            <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
              <Text size="sm" fw={600}>
                {t('office.settings.nav_this_device')}
              </Text>
              <Text size="xs" c="dimmed" data-testid="this-device">
                {info.tenant?.display_name ?? ''} · {info.device.name} ·{' '}
                {info.device.code} ·{' '}
                {info.device.is_admin
                  ? t('office.settings.nav_admin_device')
                  : t('office.settings.nav_till_device')}
              </Text>
            </Stack>
          </Group>
          {owner && info.enrolled ? (
            <Stack gap="xs" mt="sm">
              <Text size="xs" c="dimmed">
                {t('office.settings.nav_leave_hint')}
              </Text>
              <Button
                color="red"
                variant="light"
                size="compact-sm"
                onClick={() => void leave()}
                style={{ alignSelf: 'flex-start' }}
              >
                {t('office.settings.nav_leave')}
              </Button>
              {leaveError ? (
                <Text role="alert" size="xs" c="red">
                  {leaveError}
                </Text>
              ) : null}
            </Stack>
          ) : null}
        </Paper>
      ) : null}
    </Stack>
  );
}

function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Stack gap="xs">
      <Text size="xs" fw={700} c="dimmed" px={4}>
        {title}
      </Text>
      <Paper withBorder style={{ overflow: 'hidden' }}>
        {children}
      </Paper>
    </Stack>
  );
}

function SettingsRow({
  to,
  icon,
  title,
  hint,
  active,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  hint: string;
  active?: boolean;
}) {
  const { pathname } = useLocation();
  const current =
    active ?? pathname.replace(/\/+$/u, '') === to.replace(/\/+$/u, '');
  return (
    <UnstyledButton
      component={Link}
      to={to}
      resetScroll={false}
      onClick={rememberListScroll}
      aria-current={current ? 'page' : undefined}
      w="100%"
      px="md"
      py="sm"
      style={{
        borderTop: '1px solid var(--mantine-color-default-border)',
        background: current ? 'var(--mantine-color-brand-0)' : undefined,
      }}
    >
      <Group gap="md" wrap="nowrap">
        <ThemeIcon
          size={36}
          radius="md"
          variant={current ? 'filled' : 'light'}
          color={current ? 'brand' : 'gray'}
        >
          {icon}
        </ThemeIcon>
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" fw={600} c={current ? 'brand.9' : undefined}>
            {title}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={2}>
            {hint}
          </Text>
        </Box>
        <Text aria-hidden="true" c="dimmed" className="rtl:rotate-180">
          ›
        </Text>
      </Group>
    </UnstyledButton>
  );
}
