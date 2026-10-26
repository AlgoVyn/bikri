import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/EmptyState.tsx';
import { ClockIcon } from '../components/icons.tsx';

export const Route = createFileRoute('/$')({
  component: CatchAllPage,
});

function CatchAllPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={<ClockIcon />}
      heading={t('common.not_found')}
      message={t('common.not_found')}
      actionLabel={t('common.go_home')}
      onAction={() => {
        void navigate({ to: '/' });
      }}
    />
  );
}
