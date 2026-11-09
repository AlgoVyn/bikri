import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/EmptyState.tsx';
import { SearchIcon } from '../components/icons.tsx';

export const Route = createFileRoute('/$')({
  component: CatchAllPage,
});

function CatchAllPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={<SearchIcon />}
      heading={t('common.not_found')}
      showHeading
      message={t('common.not_found_hint')}
      actionLabel={t('common.go_home')}
      onAction={() => {
        void navigate({ to: '/' });
      }}
    />
  );
}
