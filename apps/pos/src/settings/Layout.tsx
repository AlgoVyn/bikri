import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from '../components/classes.ts';

/** Shared Settings subpage frame with a back link and title. */
export function SettingsPageLayout({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/settings" className={buttonQuiet}>
          {t('common.back')}
        </Link>
        <h1 className="text-h1 font-semibold">{title}</h1>
      </div>
      {children}
    </div>
  );
}
