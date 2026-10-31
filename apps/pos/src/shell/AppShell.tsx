import {
  Box,
  Divider,
  Group,
  AppShell as MantineAppShell,
  Menu,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MoreIcon,
  SalesIcon,
  SearchIcon,
  SettingsIcon,
} from '../components/icons.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { ReadOnlyError } from '../data/write.ts';
import { usePrintService } from '../print/usePrintService.ts';
import { useUpdateReady } from '../pwa/useUpdateReady.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { Banners } from './Banners.tsx';
import { GlobalSearch } from './GlobalSearch.tsx';
import { ignoresHotkey } from './hotkeys.ts';
import { NAV, type NavItem, navItemFor } from './nav.ts';
import { PriceCheck } from './PriceCheck.tsx';
import { usePriceCheck } from './priceCheckStore.ts';
import {
  PrinterDot,
  StaffMenu,
  SyncBadge,
  useShopName,
} from './TopBarParts.tsx';

const EXTRA_TITLES: Record<string, string> = {
  '/day-close': 'home.day_close',
  '/stock/count': 'count.title',
  '/labels': 'products.print_label',
};

const _railText = 'rgba(241, 245, 249, 0.72)';
const railMuted = 'rgba(184, 198, 219, 0.78)';

export function AppShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToast();
  const { updateReady, applyUpdate } = useUpdateReady();
  usePrintService();
  const { can } = useCurrentStaff();
  const shopName = useShopName();
  const openPriceCheck = usePriceCheck((s) => s.setOpen);
  const desktop = useMediaQuery('(min-width: 1024px)', false, {
    getInitialValueInEffect: false,
  });

  const allowed = (item: NavItem) => item.perm === null || can(item.perm);
  const visible = NAV.filter(allowed);
  const current = navItemFor(pathname);
  const extraTitle = EXTRA_TITLES[pathname.replace(/\/+$/u, '')];
  const screenTitle = current
    ? t(current.label)
    : extraTitle
      ? t(extraTitle)
      : null;
  const blocked = current !== undefined && !allowed(current);
  const more = visible.filter((item) => !item.bar);

  useEffect(() => {
    document.title = t('common.app_title');
  }, [t]);

  useEffect(() => {
    let alive = true;
    void import('./devicePrefs.ts').then(async (module) => {
      const prefs = await module.loadDevicePrefs(getDb());
      if (alive)
        module.applyDevicePrefs(
          { ...prefs, theme: module.storedTheme() },
          i18n.language,
        );
    });
    return () => {
      alive = false;
    };
  }, [i18n.language]);

  useEffect(() => {
    void import('../sell/SaleComplete.tsx').catch(() => undefined);
  }, []);

  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!(event.reason instanceof ReadOnlyError)) return;
      event.preventDefault();
      toast.push(t('tenant.readOnly.blocked'), 'error');
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [t, toast]);

  useEffect(() => {
    if (!blocked) return;
    toast.push(t('shell.no_access'), 'error');
    void navigate({ to: '/', replace: true });
  }, [blocked, navigate, t, toast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.code === 'KeyP'
      ) {
        event.preventDefault();
        openPriceCheck(true);
        return;
      }
      if (
        event.defaultPrevented ||
        event.metaKey ||
        ignoresHotkey(event.target)
      )
        return;
      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === 'n' || event.key === 'N')
      ) {
        if (!can('sale.create')) return;
        event.preventDefault();
        void navigate({ to: '/sell' });
        return;
      }
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      const digit = /^Digit([1-9])$/u.exec(event.code)?.[1];
      const item = digit === undefined ? undefined : NAV[Number(digit) - 1];
      if (item === undefined || !allowed(item)) return;
      event.preventDefault();
      void navigate({ to: item.to });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
      <MantineAppShell
        header={{ height: 60 }}
        navbar={{ width: 88, breakpoint: 'lg', collapsed: { mobile: true } }}
        padding={0}
        styles={{
          header: {
            background: 'var(--mantine-color-body)',
            borderBottom: '1px solid var(--mantine-color-default-border)',
          },
          navbar: {
            background: 'var(--bikri-rail, #182e55)',
            border: 0,
            borderInlineEnd: '1px solid rgb(255 255 255 / 0.08)',
          },
          main: {
            background: 'var(--mantine-color-body)',
          },
        }}
      >
        <MantineAppShell.Header>
          <Group
            h="100%"
            px={{ base: 'sm', sm: 'md' }}
            justify="space-between"
            wrap="nowrap"
            gap="sm"
          >
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
              <UnstyledButton
                component={Link}
                to="/"
                data-testid="brand-topbar"
                className="bikri-topbar-brand"
              >
                <ThemeIcon
                  size={36}
                  radius="md"
                  color="accent"
                  variant="filled"
                >
                  <SalesIcon />
                </ThemeIcon>
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Text
                    fw={800}
                    size="sm"
                    tt="uppercase"
                    style={{ letterSpacing: '0.14em', lineHeight: 1.1 }}
                  >
                    {t('common.app_name')}
                  </Text>
                  {shopName ? (
                    <Text
                      size="10px"
                      c="dimmed"
                      truncate
                      maw={160}
                      visibleFrom="sm"
                    >
                      {shopName}
                    </Text>
                  ) : null}
                </Stack>
              </UnstyledButton>
              <Divider
                orientation="vertical"
                visibleFrom="md"
                color="var(--mantine-color-default-border)"
              />
              <Text
                data-testid="screen-title-bar"
                fw={650}
                size="sm"
                truncate
                visibleFrom="sm"
              >
                {screenTitle ?? shopName ?? t('common.app_name')}
              </Text>
            </Group>
            <Box
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <GlobalSearch />
            </Box>
            <Group gap={4} wrap="nowrap">
              {updateReady ? (
                <UnstyledButton
                  onClick={() => applyUpdate()}
                  px="sm"
                  py={6}
                  style={{
                    borderRadius: 10,
                    background: 'var(--mantine-color-brand-6)',
                    color: 'var(--mantine-color-white)',
                    fontWeight: 600,
                  }}
                >
                  {t('shell.update_ready')}
                </UnstyledButton>
              ) : null}
              <Box visibleFrom="lg">
                <SyncBadge />
              </Box>
              <Box visibleFrom="lg">
                <PrinterDot />
              </Box>
              <LanguageSelect />
              <StaffMenu />
            </Group>
          </Group>
        </MantineAppShell.Header>

        {desktop ? (
          <MantineAppShell.Navbar p={0} aria-label={t('nav.rail')}>
            <Stack justify="space-between" h="100%" gap={0}>
              <Stack gap={4} p={8} pt="md" style={{ overflowY: 'auto' }}>
                {visible.map((item) => {
                  const active = current?.to === item.to;
                  return (
                    <Tooltip
                      key={item.to}
                      label={`${t(item.label)} (${item.keys})`}
                      position="right"
                      withArrow
                      openDelay={400}
                    >
                      <Link
                        to={item.to}
                        aria-label={`${t(item.label)} (${item.keys})`}
                        aria-current={active ? 'page' : undefined}
                        className="bikri-rail-item"
                        data-active={active || undefined}
                      >
                        <item.Icon />
                        <Text size="10px" lh={1.15} ta="center" tt="none">
                          {t(item.label)}
                        </Text>
                      </Link>
                    </Tooltip>
                  );
                })}
                <Divider my={6} color="rgba(255,255,255,0.10)" />
                <Tooltip
                  label={`${t('pricecheck.title')} (Ctrl+Shift+P)`}
                  position="right"
                  withArrow
                  openDelay={400}
                >
                  <UnstyledButton
                    className="bikri-rail-item"
                    onClick={() => openPriceCheck(true)}
                  >
                    <SearchIcon />
                    <Text size="10px" lh={1.15} ta="center">
                      {t('pricecheck.title')}
                    </Text>
                  </UnstyledButton>
                </Tooltip>
              </Stack>
              <Stack gap={2} p={8} pb="md" align="center">
                {import.meta.env.DEV ? (
                  <UnstyledButton
                    component={Link}
                    to="/dev/ui"
                    style={{ color: railMuted }}
                  >
                    <SettingsIcon />
                  </UnstyledButton>
                ) : null}
                {shopName ? (
                  <Text
                    size="9px"
                    ta="center"
                    lineClamp={2}
                    title={shopName}
                    data-testid="rail-shop-name"
                    style={{ color: railMuted }}
                  >
                    {shopName}
                  </Text>
                ) : null}
              </Stack>
            </Stack>
          </MantineAppShell.Navbar>
        ) : null}

        <MantineAppShell.Main className="pb-[76px] lg:pb-0">
          <Banners />
          {blocked ? null : children}
        </MantineAppShell.Main>
      </MantineAppShell>

      {!desktop ? (
        <Box
          component="nav"
          aria-label={t('nav.rail')}
          className="fixed inset-x-0 bottom-0 z-30"
          style={{
            borderTop: '1px solid var(--mantine-color-default-border)',
            background: 'var(--mantine-color-body)',
            paddingBottom: 'env(safe-area-inset-bottom)',
          }}
        >
          <Group gap={0} justify="space-around" align="stretch" wrap="nowrap">
            {visible
              .filter((item) => item.bar)
              .map((item) => {
                const active = current?.to === item.to;
                return (
                  <UnstyledButton
                    key={item.to}
                    component={Link}
                    to={item.to}
                    className="bikri-tab-item"
                    data-active={active || undefined}
                    aria-current={active ? 'page' : undefined}
                  >
                    <item.Icon />
                    <Text size="10px" lh={1.1}>
                      {t(item.label)}
                    </Text>
                  </UnstyledButton>
                );
              })}
            {more.length > 0 ? (
              <Menu position="top-end" width={220} shadow="lg" radius="md">
                <Menu.Target>
                  <UnstyledButton className="bikri-tab-item">
                    <MoreIcon />
                    <Text size="10px" lh={1.1}>
                      {t('nav.more')}
                    </Text>
                  </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                  <Box id="more-menu">
                    <Menu.Label>{shopName ?? t('common.app_name')}</Menu.Label>
                    {more.map((item) => (
                      <Menu.Item
                        key={item.to}
                        component={Link}
                        to={item.to}
                        leftSection={<item.Icon />}
                      >
                        {t(item.label)}
                      </Menu.Item>
                    ))}
                    <Menu.Divider />
                    <Menu.Item
                      leftSection={<SearchIcon />}
                      onClick={() => openPriceCheck(true)}
                    >
                      {t('pricecheck.title')}
                    </Menu.Item>
                    <Menu.Divider />
                    <Box px="sm" py={4} hiddenFrom="lg">
                      <SyncBadge compact />
                      <PrinterDot compact />
                    </Box>
                  </Box>
                </Menu.Dropdown>
              </Menu>
            ) : null}
          </Group>
        </Box>
      ) : null}

      <PriceCheck />
    </>
  );
}
