import { Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * The shared page header: icon tile, title, optional subtitle and end actions.
 * The icon is decorative; the heading is the accessible title.
 */
export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
  tone = 'bg-primary-subtle text-primary-subtle-ink',
  headingLevel = 'h1',
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  tone?: string;
  headingLevel?: 'h1' | 'h2';
}) {
  const color = tone.includes('warning')
    ? 'yellow'
    : tone.includes('success')
      ? 'green'
      : tone.includes('danger')
        ? 'red'
        : 'brand';
  return (
    <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
      <Group align="flex-start" gap="md" wrap="nowrap" style={{ minWidth: 0 }}>
        {icon ? (
          <ThemeIcon size={44} radius="md" variant="light" color={color}>
            {icon}
          </ThemeIcon>
        ) : null}
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Title order={headingLevel === 'h2' ? 2 : 1}>{title}</Title>
          {subtitle ? (
            <Text size="sm" c="dimmed">
              {subtitle}
            </Text>
          ) : null}
        </Stack>
      </Group>
      {actions ? (
        <Group gap="sm" wrap="wrap" justify="flex-end">
          {actions}
        </Group>
      ) : null}
    </Group>
  );
}
