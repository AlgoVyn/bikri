import { businessDate, type Permission } from '@bikri/core';
import {
  Badge,
  Box,
  Button,
  Divider,
  Grid,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import {
  ClockIcon,
  ProductsIcon,
  SalesIcon,
  SearchIcon,
  SellIcon,
} from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { getDb } from '../data/db.ts';
import {
  type AttentionItem,
  attentionItems,
  recentBills,
} from '../data/home.ts';
import { defaultBranch, deviceInfo } from '../data/localTenant.ts';
import { expectedCash, summary } from '../data/reports.ts';
import { formatTimestamp } from '../lib/date';
import { formatShopMoney } from '../lib/money';
import { NAV } from '../shell/nav.ts';
import { usePriceCheck } from '../shell/priceCheckStore.ts';
import { useOnline } from '../shell/TopBarParts.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useSession } from '../state/session.ts';

type HomeData = {
  branchName: string;
  products: number;
  today: Awaited<ReturnType<typeof summary>>;
  cash: number;
  attention: AttentionItem[];
  recent: Awaited<ReturnType<typeof recentBills>>;
};

type QuickTile = {
  to: string;
  label: string;
  desc: string;
  keys: string;
  Icon: () => React.JSX.Element;
  perm: Permission | null;
};

const QUICK_DESC: Record<string, string> = {
  '/products': 'home.desc_products',
  '/sales': 'home.desc_sales',
  '/udhaar': 'home.desc_udhaar',
  '/suppliers': 'home.desc_suppliers',
  '/expenses': 'home.desc_expenses',
  '/reports': 'home.desc_reports',
  '/settings': 'home.desc_settings',
};

const DAY_MS = 86_400_000;

const ATTENTION_LINK: Record<string, string> = {
  low_stock: '/products',
  promises_due: '/udhaar/chase',
  over_limit: '/udhaar',
  failed_prints: '/settings',
  conflicts: '/settings/sync',
  sync_stale: '/settings/sync',
  sync_pending_old: '/settings/sync',
  clock_wrong: '/settings/sync',
  day_not_closed: '/day-close',
  held_expiring: '/sell',
};

/** Home (screens/04): a calm daily overview with one obvious next action. */
export function HomePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const justSetUp = useSession((s) => s.justSetUp);
  const setJustSetUp = useSession((s) => s.setJustSetUp);
  const { staff, role, can } = useCurrentStaff();
  const online = useOnline();
  const now = Date.now();
  const today = businessDate(now);
  const yesterday = businessDate(now - DAY_MS);

  const data = useLiveQuery(async (): Promise<HomeData> => {
    const db = getDb();
    const device = await deviceInfo(db);
    const branch = await defaultBranch(db);
    const deviceId = device?.id ?? '';
    return {
      branchName: String(branch?.name ?? ''),
      products: await db.products.filter((p) => !p.deleted_at).count(),
      today: await summary(db, { from: today, to: today }),
      cash: await expectedCash(db, deviceId),
      attention: await attentionItems(db, {
        today,
        yesterday,
        deviceId,
        isOwner: role === 'owner',
      }),
      recent: await recentBills(db),
    };
  }, [today, yesterday, role]);

  const dateText = formatTimestamp(
    now,
    i18n.language,
    'Asia/Karachi',
    'weekdayLong',
  );
  const timeText = (at: number) =>
    formatTimestamp(at, i18n.language, 'Asia/Karachi', 'time');

  const tiles: QuickTile[] = [
    {
      to: '/day-close',
      label: 'home.day_close',
      desc: 'home.desc_day_close',
      keys: 'D',
      Icon: ClockIcon,
      perm: 'dayclose.create' as const,
    },
    ...NAV.slice(2).map((item) => ({
      to: item.to,
      label: item.label,
      desc: QUICK_DESC[item.to] ?? 'home.quick_actions',
      keys: item.keys,
      Icon: item.Icon,
      perm: item.perm,
    })),
  ].filter((tile) => tile.perm === null || can(tile.perm));

  return (
    <Stack gap="xl" maw={1220} mx="auto" p={{ base: 'md', lg: 'xl' }}>
      <Group justify="space-between" align="flex-start" gap="md">
        <Stack gap={4}>
          <Title order={1}>
            {t('home.greeting', { name: String(staff?.name ?? '') })}
          </Title>
          <Group gap="xs" wrap="wrap">
            <Text size="sm" c="dimmed">
              {dateText}
            </Text>
            {data?.branchName ? (
              <>
                <Text size="sm" c="dimmed" aria-hidden="true">
                  ·
                </Text>
                <Text size="sm" c="dimmed">
                  {data.branchName}
                </Text>
              </>
            ) : null}
            {online ? null : (
              <Badge color="warning" variant="filled" radius="xl">
                {t('home.as_of_device')}
              </Badge>
            )}
          </Group>
        </Stack>
      </Group>

      {justSetUp ? (
        <Paper p="lg" withBorder>
          <Stack gap="sm">
            <Title order={2}>{t('setup.ready')}</Title>
            <Group gap="sm">
              <Button
                onClick={() => {
                  setJustSetUp(false);
                  void navigate({ to: '/sell' });
                }}
              >
                {t('setup.start_selling')}
              </Button>
              <Button
                variant="default"
                onClick={() => {
                  setJustSetUp(false);
                  void navigate({ to: '/settings' });
                }}
              >
                {t('setup.setup_printer')}
              </Button>
            </Group>
          </Stack>
        </Paper>
      ) : null}

      {data && data.products === 0 ? (
        <Paper p="lg" withBorder>
          <Group align="flex-start" gap="md" wrap="nowrap">
            <ThemeIcon size={44} radius="md" variant="light">
              <ProductsIcon />
            </ThemeIcon>
            <Stack gap={4} style={{ minWidth: 0 }}>
              <Title order={2}>{t('home.first_products')}</Title>
              <Text c="dimmed">{t('home.no_products')}</Text>
            </Stack>
          </Group>
          {can('catalog.edit') ? (
            <Group gap="sm" mt="md">
              <Button component={Link} to="/products/new">
                {t('home.add_product')}
              </Button>
              <Button component={Link} to="/products/import" variant="default">
                {t('home.import')}
              </Button>
              <Button
                component={Link}
                to="/products/suggested"
                variant="subtle"
              >
                {t('home.suggested')}
              </Button>
            </Group>
          ) : null}
        </Paper>
      ) : null}

      <UnstyledButton component={Link} to="/sell" w="100%">
        <Paper
          p={{ base: 'lg', sm: 'xl' }}
          radius="lg"
          style={{
            background:
              'linear-gradient(135deg, var(--mantine-color-brand-7) 0%, var(--mantine-color-brand-9) 100%)',
            color: 'var(--mantine-color-white)',
          }}
        >
          <Group wrap="nowrap" gap="lg">
            <ThemeIcon
              size={56}
              radius="lg"
              variant="white"
              color="brand"
              style={{ color: 'var(--mantine-color-brand-7)' }}
            >
              <SellIcon />
            </ThemeIcon>
            <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
              <Text fw={650} fz={20}>
                {t('home.new_sale')}
              </Text>
              <Text size="sm" style={{ color: 'rgba(255,255,255,0.78)' }}>
                {t('home.new_sale_hint')}
              </Text>
            </Stack>
            <Text
              aria-hidden="true"
              fz={28}
              style={{ opacity: 0.75 }}
              className="rtl:rotate-180"
            >
              ›
            </Text>
          </Group>
        </Paper>
      </UnstyledButton>

      <Grid gap="xl">
        <Grid.Col span={{ base: 12, lg: 8 }} order={{ base: 2, lg: 1 }}>
          <Stack gap="xl">
            <QuickActions tiles={tiles} />
            {data && data.attention.length > 0 ? (
              <AttentionList items={data.attention} />
            ) : null}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }} order={{ base: 1, lg: 2 }}>
          <Stack gap="lg">
            {data ? (
              <RegisterCard
                data={data}
                showCash={can('dayclose.view_expected')}
                showProfit={can('cost.view')}
                canClose={can('dayclose.create')}
                timeText={timeText}
              />
            ) : null}
            <RecentBillsCard data={data} timeText={timeText} />
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function QuickActions({ tiles }: { tiles: readonly QuickTile[] }) {
  const { t } = useTranslation();
  const openPriceCheck = usePriceCheck((s) => s.setOpen);
  return (
    <Box component="section" aria-labelledby="quick-heading">
      <Stack gap="sm">
        <Title order={3} id="quick-heading" fz="sm" c="dimmed">
          {t('home.quick_actions')}
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
          {tiles.map((tile) => (
            <UnstyledButton
              key={tile.to + tile.label}
              component={Link}
              to={tile.to}
              title={`${t(tile.label)} (${tile.keys})`}
              h="100%"
            >
              <Paper p="md" h="100%" withBorder>
                <Group align="flex-start" wrap="nowrap" gap="sm">
                  <ThemeIcon size={40} radius="md" variant="light">
                    <tile.Icon />
                  </ThemeIcon>
                  <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                    <Text size="sm" fw={600} lineClamp={1}>
                      {t(tile.label)}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {t(tile.desc)}
                    </Text>
                  </Stack>
                  <Text
                    aria-hidden="true"
                    c="dimmed"
                    className="rtl:rotate-180"
                  >
                    ›
                  </Text>
                </Group>
              </Paper>
            </UnstyledButton>
          ))}
          <UnstyledButton
            title={`${t('home.price_check')} (Ctrl+Shift+P)`}
            onClick={() => openPriceCheck(true)}
            h="100%"
          >
            <Paper p="md" h="100%" withBorder>
              <Group align="flex-start" wrap="nowrap" gap="sm">
                <ThemeIcon size={40} radius="md" variant="light">
                  <SearchIcon />
                </ThemeIcon>
                <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                  <Text size="sm" fw={600} lineClamp={1}>
                    {t('home.price_check')}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {t('home.desc_price_check')}
                  </Text>
                </Stack>
                <Text aria-hidden="true" c="dimmed" className="rtl:rotate-180">
                  ›
                </Text>
              </Group>
            </Paper>
          </UnstyledButton>
        </SimpleGrid>
      </Stack>
    </Box>
  );
}

function RegisterCard({
  data,
  showCash,
  showProfit,
  canClose,
  timeText,
}: {
  data: HomeData;
  showCash: boolean;
  showProfit: boolean;
  canClose: boolean;
  timeText: (at: number) => string;
}) {
  const { t } = useTranslation();
  const last = data.recent[0]?.sale.created_at;
  return (
    <Paper
      component="section"
      aria-labelledby="register-heading"
      p="lg"
      withBorder
    >
      <Group justify="space-between" align="flex-start" gap="sm">
        <Title order={3} id="register-heading" fz="sm" c="dimmed">
          {t('home.todays_register')}
        </Title>
        {last ? (
          <Text size="xs" c="dimmed">
            {t('home.last_bill', { time: timeText(Number(last)) })}
          </Text>
        ) : null}
      </Group>
      <Stack gap={2} mt="md" data-testid="today-sold">
        <Text size="sm" c="dimmed">
          {t('home.sold_today')}
        </Text>
        <Text fw={700} fz={30} lh={1.1}>
          <MoneyText paisa={data.today.sold} />
        </Text>
        <Text size="sm" c="dimmed">
          {t('home.bills_count', { count: data.today.bills })}
        </Text>
      </Stack>
      <Divider my="md" />
      <SimpleGrid cols={2} spacing="md">
        {showCash ? (
          <Stack gap={2} data-testid="today-cash">
            <Text size="xs" c="dimmed">
              {t('home.cash_drawer')}
            </Text>
            <Text fw={600}>
              <MoneyText paisa={data.cash} />
            </Text>
          </Stack>
        ) : null}
        {showProfit ? (
          <Stack gap={2} data-testid="today-profit">
            <Text size="xs" c="dimmed">
              {t('home.profit_today')}
            </Text>
            <Text fw={600}>
              <MoneyText paisa={data.today.grossProfit} />
            </Text>
          </Stack>
        ) : null}
        <Stack
          gap={2}
          style={{ gridColumn: '1 / -1' }}
          data-testid="today-udhaar"
        >
          <Text size="xs" c="dimmed">
            {t('home.udhaar_today')}
          </Text>
          <Group gap="lg">
            <Text size="sm">
              {t('home.udhaar_given', {
                amount: formatShopMoney(data.today.udhaarGiven),
              })}
            </Text>
            <Text size="sm">
              {t('home.udhaar_received', {
                amount: formatShopMoney(data.today.udhaarReceived),
              })}
            </Text>
          </Group>
        </Stack>
      </SimpleGrid>
      {canClose ? (
        <Button
          component={Link}
          to="/day-close"
          variant="default"
          fullWidth
          mt="md"
        >
          {t('home.day_close')}
        </Button>
      ) : null}
    </Paper>
  );
}

function RecentBillsCard({
  data,
  timeText,
}: {
  data: HomeData | undefined;
  timeText: (at: number) => string;
}) {
  const { t } = useTranslation();
  const _navigate = useNavigate();
  const recent = data?.recent ?? [];
  return (
    <Paper
      component="section"
      aria-labelledby="recent-heading"
      withBorder
      style={{ overflow: 'hidden' }}
    >
      <Group gap="sm" px="lg" py="md" justify="space-between">
        <Title order={3} id="recent-heading">
          {t('home.recent_bills')}
        </Title>
        <Text
          component={Link}
          to="/sales"
          size="sm"
          fw={600}
          c="brand"
          style={{ textDecoration: 'none' }}
        >
          {t('home.view_all')}
        </Text>
      </Group>
      <Divider />
      {data?.recent.length === 0 ? (
        <Stack align="center" gap="sm" py="xl" px="lg">
          <ThemeIcon size={40} radius="xl" variant="light" color="gray">
            <SalesIcon />
          </ThemeIcon>
          <Text size="sm" c="dimmed">
            {t('home.no_bills')}
          </Text>
        </Stack>
      ) : null}
      {recent.map(({ sale, methods }) => (
        <Link
          key={sale.id}
          to="/sales/$id"
          params={{ id: sale.id }}
          style={{
            display: 'block',
            padding: '10px 16px',
            borderTop: '1px solid var(--mantine-color-default-border)',
            color: 'inherit',
            textDecoration: 'none',
          }}
        >
          <Group justify="space-between" gap="sm" wrap="nowrap">
            <Text size="sm" ff="monospace" fw={600} dir="ltr">
              {String(sale.invoice_no)}
            </Text>
            <Text size="sm" fw={600}>
              <MoneyText paisa={Number(sale.total)} />
            </Text>
          </Group>
          <Group gap="xs" mt={4} wrap="wrap">
            <Text size="xs" c="dimmed" dir="ltr">
              {timeText(Number(sale.created_at))}
            </Text>
            {methods.map((m) => (
              <Badge
                key={m}
                size="sm"
                variant="light"
                color="gray"
                radius="xl"
                tt="none"
              >
                {t(`payment.${m}`)}
              </Badge>
            ))}
          </Group>
        </Link>
      ))}
    </Paper>
  );
}

function AttentionList({ items }: { items: readonly AttentionItem[] }) {
  const { t, i18n } = useTranslation();
  return (
    <Box component="section" aria-labelledby="attention-heading">
      <Stack gap="sm">
        <Title order={3} id="attention-heading" fz="sm" c="dimmed">
          {t('home.attention')}
        </Title>
        <Paper withBorder style={{ overflow: 'hidden' }}>
          {items.map((item) => (
            <UnstyledButton
              key={item.kind}
              component={Link}
              to={ATTENTION_LINK[item.kind] ?? '/'}
              w="100%"
              px="md"
              py="sm"
              data-testid={`attn-${item.kind}`}
              style={{
                borderTop: '1px solid var(--mantine-color-default-border)',
              }}
            >
              <Group gap="sm" wrap="nowrap">
                <Box
                  aria-hidden="true"
                  w={8}
                  h={8}
                  style={{
                    borderRadius: 999,
                    background: 'currentColor',
                    color: attentionColor(item),
                  }}
                />
                <Text size="sm" fw={550} style={{ flex: 1 }}>
                  {attentionText(t, i18n.language, item)}
                </Text>
                <Text aria-hidden="true" c="dimmed" className="rtl:rotate-180">
                  ›
                </Text>
              </Group>
            </UnstyledButton>
          ))}
        </Paper>
      </Stack>
    </Box>
  );
}

function attentionColor(item: AttentionItem): string {
  if (item.kind === 'sync_stale')
    return item.severe
      ? 'var(--mantine-color-danger-6)'
      : 'var(--mantine-color-warning-7)';
  if (item.kind === 'clock_wrong' || item.kind === 'sync_pending_old')
    return 'var(--mantine-color-warning-7)';
  return 'var(--mantine-color-brand-6)';
}

function attentionKey(kind: string): string {
  return kind === 'promises_due' ? 'promises' : kind;
}

function attentionText(
  t: (key: string, opts?: Record<string, unknown>) => string,
  lang: string,
  item: AttentionItem,
): string {
  switch (item.kind) {
    case 'day_not_closed':
      return t('home.attn_day_not_closed', { date: item.date });
    case 'sync_stale':
      return item.severe
        ? t('home.attn_sync_stale_severe', {
            days: Math.max(30 - item.days, 0),
          })
        : t('home.attn_sync_stale', { days: item.days });
    case 'sync_pending_old':
      return t('home.attn_sync_pending_old', {
        time: new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK' : 'en-PK', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Karachi',
        }).format(item.since),
      });
    case 'clock_wrong':
      return t('home.attn_clock_wrong');
    default:
      return t(`home.attn_${attentionKey(item.kind)}`, { count: item.count });
  }
}
