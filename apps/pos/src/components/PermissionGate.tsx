import type { Permission } from '@bikri/core';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { buttonQuiet } from './classes.ts';

/** Refuses a URL-opened screen the current profile may not use (screens/04 AC 2). */
export function PermissionGate({
  permission,
  anyOf,
  blockReadOnly = false,
  children,
}: {
  permission?: Permission;
  /** Any one of these is enough (e.g. label printing for catalogue or purchasing). */
  anyOf?: readonly Permission[];
  /** A screen that only creates data must also refuse a read-only shop. */
  blockReadOnly?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const allowed = anyOf
    ? anyOf.some((p) => can(p))
    : permission
      ? can(permission)
      : true;
  if (!allowed || (blockReadOnly && readOnly))
    return (
      <div
        className="mx-auto flex max-w-lg flex-col items-center gap-3 p-8 text-center"
        data-testid="permission-no-access"
      >
        <p className="text-text-muted">
          {!allowed ? t('shell.no_access') : t('tenant.readOnly.blocked')}
        </p>
        <Link to="/" className={buttonQuiet}>
          {t('nav.home')}
        </Link>
      </div>
    );
  return children;
}
