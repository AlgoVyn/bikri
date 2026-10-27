import type { Permission } from '@bikri/core';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { buttonQuiet } from './classes.ts';

/** Refuses a URL-opened screen the current profile may not use (screens/04 AC 2). */
export function PermissionGate({
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
        data-testid="permission-no-access"
      >
        <p className="text-text-muted">{t('shell.no_access')}</p>
        <Link to="/" className={buttonQuiet}>
          {t('nav.home')}
        </Link>
      </div>
    );
  return children;
}
