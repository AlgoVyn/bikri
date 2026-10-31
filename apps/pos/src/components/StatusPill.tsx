import { Box, Group, Text } from '@mantine/core';

const COLOURS: Record<string, string> = {
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  brand: 'var(--mantine-color-brand-6)',
  gray: 'var(--mantine-color-dimmed)',
};

/** Dot plus label: the default status treatment for tables and detail headers. */
export function StatusPill({
  label,
  tone = 'gray',
  testId,
}: {
  label: string;
  tone?: keyof typeof COLOURS;
  testId?: string;
}) {
  return (
    <Group gap={6} wrap="nowrap" data-testid={testId}>
      <Box
        aria-hidden="true"
        w={7}
        h={7}
        style={{ borderRadius: 999, background: COLOURS[tone] }}
      />
      <Text size="sm" c={tone === 'gray' ? 'dimmed' : undefined}>
        {label}
      </Text>
    </Group>
  );
}
