import { useLocation } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { pageClass } from '../components/classes.ts';
import { SettingsIcon } from '../components/icons.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { AreaStrings } from '../i18n/areas.tsx';
import { SettingsNav } from './SettingsNav.tsx';

/**
 * The landing page is one centred index, matching the other list sections. Choosing a row
 * opens that section's own page; at ≥1280 px the index stays beside it (two columns).
 */
export function SettingsIndex({ activePath }: { activePath?: string }) {
  return (
    <AreaStrings area="office">
      <div className={pageClass('standard', 'gap-6')}>
        <SettingsNav activePath={activePath} headingLevel="h1" />
      </div>
    </AreaStrings>
  );
}

/** Settings section page: index + section on desktop, section on smaller screens. */
export function SettingsPageLayout({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const activePath = pathname.replace(/\/+$/u, '');
  return (
    <AreaStrings area="office">
      <div className={pageClass('wide', 'gap-6')}>
        <div className="grid gap-6 xl:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)] xl:items-start">
          <div className="hidden min-w-0 xl:sticky xl:top-[calc(var(--spacing-topbar)+1.5rem)] xl:block xl:max-h-[calc(100dvh-var(--spacing-topbar)-3rem)] xl:overflow-y-auto xl:[scrollbar-width:thin]">
            <SettingsNav activePath={activePath} headingLevel="h2" />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <SubpageHeader
              backTo="/settings"
              backLabel={t('common.back')}
              icon={icon ?? <SettingsIcon />}
              title={title}
            />
            {children}
          </div>
        </div>
      </div>
    </AreaStrings>
  );
}
