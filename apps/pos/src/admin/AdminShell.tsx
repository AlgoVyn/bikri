import { AppShell, Box, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { Link, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CloudIcon,
  ReportsIcon,
  SalesIcon,
  StoreIcon,
} from '../components/icons.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { useAreaStrings } from '../i18n/areas.tsx';
import { applyStoredTheme } from '../shell/devicePrefs.ts';

const NAV = [
  { to: '/admin', label: 'admin.nav_overview', Icon: ReportsIcon },
  { to: '/admin/tenants', label: 'admin.nav_tenants', Icon: StoreIcon },
  { to: '/admin/backups', label: 'admin.nav_backups', Icon: CloudIcon },
] as const;

function AdminNav({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation();
  return (
    <Group gap={4} wrap={mobile ? 'nowrap' : 'wrap'} p={mobile ? 0 : 'sm'}>
      {NAV.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: item.to === '/admin' }}
          className={mobile ? 'bikri-admin-tab' : 'bikri-admin-nav'}
        >
          <item.Icon />
          <Text size="sm" fw={550}>
            {t(item.label)}
          </Text>
        </Link>
      ))}
    </Group>
  );
}

/** Operator console shell: same brand language as the till, separate from the shop DB. */
export function AdminShell() {
  const { t } = useTranslation();
  const ready = useAreaStrings('admin');
  useEffect(() => {
    applyStoredTheme();
  }, []);
  useEffect(() => {
    if (ready) document.title = t('admin.title');
  }, [t, ready]);
  if (!ready) return <p className="sr-only">{t('common.loading')}</p>;
  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 244, breakpoint: 'lg', collapsed: { mobile: true } }}
      padding={0}
      styles={{
        header: {
          background: 'var(--mantine-color-body)',
          borderBottom: '1px solid var(--mantine-color-default-border)',
        },
        navbar: {
          background: 'var(--bikri-rail, #182e55)',
          border: 0,
        },
        main: { background: 'var(--mantine-color-body)' },
      }}
    >
      <a href="#admin-main" className="sr-only focus:not-sr-only">
        {t('admin.skip_content')}
      </a>
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Box hiddenFrom="lg">
              <Link to="/admin" className="flex items-center gap-2">
                <ThemeIcon
                  size={34}
                  radius="md"
                  color="accent"
                  variant="filled"
                >
                  <SalesIcon />
                </ThemeIcon>
                <Text size="sm" fw={700} tt="uppercase">
                  {t('common.app_name')}
                </Text>
              </Link>
            </Box>
            <Text size="sm" c="dimmed" visibleFrom="lg">
              {t('admin.operator_label')}
            </Text>
          </Group>
          <LanguageSelect />
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p={0} aria-label={t('admin.title')}>
        <Stack justify="space-between" h="100%" gap={0}>
          <Box>
            <Box
              component={Link}
              to="/admin"
              px="md"
              py="md"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderBottom: '1px solid rgb(255 255 255 / 0.10)',
                textDecoration: 'none',
              }}
            >
              <ThemeIcon size={36} radius="md" color="accent" variant="filled">
                <SalesIcon />
              </ThemeIcon>
              <Stack gap={0} style={{ minWidth: 0 }}>
                <Text size="xs" fw={700} tt="uppercase" c="white">
                  {t('common.app_name')}
                </Text>
                <Text size="xs" c="rgba(184,198,219,0.8)" truncate>
                  {t('admin.title')}
                </Text>
              </Stack>
            </Box>
            <AdminNav />
          </Box>
          <Group gap="sm" px="md" py="md" wrap="nowrap">
            <Box
              aria-hidden="true"
              w={6}
              h={6}
              style={{
                borderRadius: 999,
                background: 'var(--mantine-color-accent-4)',
              }}
            />
            <Text size="xs" c="rgba(184,198,219,0.8)">
              {t('admin.access_note')}
            </Text>
          </Group>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        <Box hiddenFrom="lg" px="sm" pt="xs">
          <AdminNav mobile />
        </Box>
        <Box
          id="admin-main"
          maw={1280}
          mx="auto"
          w="100%"
          p={{ base: 'md', lg: 'lg' }}
        >
          <Outlet />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
