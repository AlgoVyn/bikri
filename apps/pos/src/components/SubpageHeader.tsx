import {
  ActionIcon,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/** Parents a utility page can return to with the shared header. */
export type SubpageParent =
  | '/'
  | '/products'
  | '/settings'
  | '/suppliers'
  | '/udhaar';

/**
 * The shared subpage header: circular back, decorative icon tile, title and end actions.
 * Settings, product utilities and Udhaar all use this frame.
 */
export function SubpageHeader({
  backTo,
  backLabel,
  icon,
  title,
  subtitle,
  actions,
}: {
  backTo: SubpageParent;
  backLabel: string;
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
      <Group align="flex-start" gap="md" wrap="nowrap" style={{ minWidth: 0 }}>
        <ActionIcon
          component={Link}
          to={backTo}
          aria-label={backLabel}
          title={backLabel}
          variant="default"
          size="lg"
          radius="md"
        >
          <span aria-hidden="true" className="rtl:rotate-180">
            ‹
          </span>
        </ActionIcon>
        {icon ? (
          <ThemeIcon size={40} radius="md" variant="light" color="gray">
            {icon}
          </ThemeIcon>
        ) : null}
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Title order={1}>{title}</Title>
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
