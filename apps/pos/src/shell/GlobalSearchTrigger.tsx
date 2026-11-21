import { useTranslation } from 'react-i18next';
import { SearchIcon } from '../components/icons.tsx';
import { useGlobalSearch } from './searchStore.ts';

export function GlobalSearchTrigger({
  variant,
}: {
  variant: 'topbar' | 'rail';
}) {
  const { t } = useTranslation();
  const openSearch = useGlobalSearch((state) => state.openSearch);
  if (variant === 'rail') {
    return (
      <button
        type="button"
        data-testid="rail-search"
        title={`${t('shell.search_label')} (/)`}
        aria-label={`${t('shell.search_label')} (/)`}
        onClick={openSearch}
        className="relative flex min-h-11 w-full flex-col items-center justify-center gap-0.5 px-1 text-small text-rail-muted transition-colors duration-150 hover:bg-rail-hover hover:text-rail-ink"
      >
        <SearchIcon />
        <span className="rail-label max-w-full truncate leading-tight">
          {t('shell.search_short')}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      data-testid="global-search-trigger"
      className="flex size-11 items-center justify-center rounded-control text-text-muted"
      aria-label={t('shell.search_label')}
      aria-haspopup="dialog"
      onClick={openSearch}
    >
      <SearchIcon />
    </button>
  );
}
