import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../components/EmptyState.tsx';
import { ClockIcon } from '../components/icons.tsx';

export function ComingSoon({
  titleKey,
  home = false,
}: {
  titleKey: string;
  home?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={<ClockIcon />}
      heading={t(titleKey)}
      message={t('common.coming_soon')}
      actionLabel={home ? t('common.go_home') : undefined}
      onAction={
        home
          ? () => {
              void navigate({ to: '/' });
            }
          : undefined
      }
    />
  );
}
