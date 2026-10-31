import {
  Box,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsIcon } from '../components/icons.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { AreaStrings } from '../i18n/areas.tsx';
import { SettingsNav } from './SettingsNav.tsx';

/**
 * Settings on ≥1280 px uses the reference app's master–detail split: the index stays on the
 * start side and the selected section fills the end side. Below that, a section is a full page.
 */
export function SettingsSplit({
  index = false,
  children,
}: {
  index?: boolean;
  children?: ReactNode;
}) {
  return (
    <AreaStrings area="office">
      <div className="mx-auto w-full max-w-[1440px] p-4 xl:p-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)] xl:items-start">
          <div
            className={`bikri-settings-nav min-w-0 ${index ? '' : 'max-xl:hidden'}`}
          >
            <SettingsNav />
          </div>
          <div className={`min-w-0 ${index ? 'hidden xl:block' : ''}`}>
            {index ? <SettingsPlaceholder /> : children}
          </div>
        </div>
      </div>
    </AreaStrings>
  );
}

function SettingsPlaceholder() {
  const { t } = useTranslation();
  return (
    <Paper withBorder p="lg">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon size={40} radius="md" variant="light" color="gray">
          <SettingsIcon />
        </ThemeIcon>
        <Stack gap={2}>
          <Title order={3} fz="lg">
            {t('office.settings.choose')}
          </Title>
          <Text size="sm" c="dimmed">
            {t('office.settings.choose_hint')}
          </Text>
        </Stack>
      </Group>
    </Paper>
  );
}

/** Shared Settings subpage frame with the split index, a back link and title. */
export function SettingsPageLayout({
  title,
  icon,
  actions,
  children,
}: {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSplit>
      <div className="flex min-w-0 flex-col gap-4">
        <SubpageHeader
          backTo="/settings"
          backLabel={t('common.back')}
          icon={icon ?? <SettingsIcon />}
          title={title}
          actions={actions}
        />
        {children}
      </div>
    </SettingsSplit>
  );
}
