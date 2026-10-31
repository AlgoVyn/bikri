import { SimpleGrid, Skeleton, Stack } from '@mantine/core';
import { useTranslation } from 'react-i18next';

/** A calm branded skeleton used while a route or a local query is loading. */
export function PageLoading({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <Stack
      gap="md"
      p="md"
      maw={compact ? undefined : 1152}
      mx={compact ? undefined : 'auto'}
      w="100%"
      aria-busy="true"
      aria-label={t('common.loading')}
      role="status"
    >
      <Skeleton height={32} width={160} radius="md" />
      <Skeleton height={96} radius="lg" />
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <Skeleton height={80} radius="lg" />
        <Skeleton height={80} radius="lg" />
      </SimpleGrid>
    </Stack>
  );
}
