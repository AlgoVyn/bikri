import {
  Group,
  Modal as MantineModal,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** A titled modal dialog (focus trap, Esc closes) on the shared Mantine surface. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  full = false,
  header,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  full?: boolean;
  /** Extra content next to the title (e.g. the total to pay). */
  header?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <MantineModal
      opened={open}
      onClose={() => onOpenChange(false)}
      centered
      size={wide ? 'lg' : 'md'}
      radius="lg"
      padding="lg"
      closeButtonProps={{ 'aria-label': t('ui.close_dialog') }}
      classNames={{ content: full ? 'bikri-modal-full' : undefined }}
      title={
        <Group justify="space-between" align="baseline" gap="sm" wrap="wrap">
          <Title order={2} fz="lg">
            {title}
          </Title>
          {header}
        </Group>
      }
    >
      <Stack gap="md">
        {description ? (
          <Text size="sm" c="dimmed">
            {description}
          </Text>
        ) : null}
        {children}
      </Stack>
    </MantineModal>
  );
}
