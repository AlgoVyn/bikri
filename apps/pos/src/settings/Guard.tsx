import type { Permission } from '@bikri/core';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from '../components/classes.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

/** Hides an owner-only settings page when opened by URL without the permission. */
export function SettingsGuard({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { can } = useCurrentStaff();
  if (!can(permission))
    return (
      <div
        className="mx-auto flex max-w-lg flex-col items-center gap-3 p-8 text-center"
        data-testid="settings-no-access"
      >
        <p className="text-text-muted">{t('shell.no_access')}</p>
        <Link to="/settings" className={buttonQuiet}>
          {t('nav.settings')}
        </Link>
      </div>
    );
  return children;
}
