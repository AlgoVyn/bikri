import { Button, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import type { ReactNode } from 'react';

/** Shared empty state: dashed surface, icon, one sentence and one action. */
export function EmptyState({
  icon,
  heading,
  message,
  actionLabel,
  onAction,
}: {
  icon?: ReactNode;
  heading?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <Paper
      withBorder
      p="xl"
      style={{
        borderStyle: 'dashed',
        background: 'transparent',
        textAlign: 'center',
      }}
    >
      <Stack align="center" gap="sm">
        {icon !== undefined ? (
          <ThemeIcon size={56} radius="xl" variant="light" color="gray">
            {icon}
          </ThemeIcon>
        ) : null}
        {heading !== undefined ? <h1 className="sr-only">{heading}</h1> : null}
        <Text maw={420} fw={500}>
          {message}
        </Text>
        {actionLabel !== undefined && onAction !== undefined ? (
          <Button onClick={onAction}>{actionLabel}</Button>
        ) : null}
      </Stack>
    </Paper>
  );
}
