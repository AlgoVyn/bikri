import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from './classes.ts';

/**
 * The standard back affordance on form/utility pages: a compact chevron + "Back" while the
 * full destination stays the accessible name (and keeps the e2e/tests readable).
 */
export function BackLink({
  to,
  label,
}: {
  to: '/products' | '/udhaar' | '/suppliers' | '/';
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <Link
      to={to}
      aria-label={label}
      title={label}
      className={`${buttonQuiet} gap-1 px-2`}
    >
      <span
        aria-hidden="true"
        className="text-title leading-none rtl:rotate-180"
      >
        ‹
      </span>
      <span>{t('common.back')}</span>
    </Link>
  );
}
