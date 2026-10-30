import { useTranslation } from 'react-i18next';

/** A calm branded skeleton used while a route or a local query is loading. */
export function PageLoading({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={
        compact
          ? 'flex flex-col gap-3 p-4'
          : 'mx-auto flex max-w-6xl flex-col gap-4 p-4'
      }
      aria-busy="true"
      aria-label={t('common.loading')}
      role="status"
    >
      <div className="h-8 w-40 animate-pulse rounded-control bg-surface-2" />
      <div className="h-24 animate-pulse rounded-card bg-surface-2" />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-20 animate-pulse rounded-card bg-surface-2" />
        <div className="h-20 animate-pulse rounded-card bg-surface-2" />
      </div>
    </div>
  );
}
