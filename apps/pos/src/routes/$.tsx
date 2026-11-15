import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { pageClass } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { SearchIcon } from '../components/icons.tsx';

export const Route = createFileRoute('/$')({
  component: CatchAllPage,
});

function CatchAllPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className={`${pageClass('focused')} min-h-[70dvh] justify-center`}>
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
    </div>
  );
}
