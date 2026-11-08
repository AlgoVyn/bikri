import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { pageClass } from '../components/classes.ts';
import { SettingsIcon } from '../components/icons.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { AreaStrings } from '../i18n/areas.tsx';
import { SettingsNav } from './SettingsNav.tsx';

/**
 * Settings is a single centred index, matching the other list sections. Choosing a row
 * opens that section as its own full page; there is no side-by-side preview.
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

/** Shared Settings subpage frame: a centred page with a back link and title. */
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
  return (
    <AreaStrings area="office">
      <div className={pageClass('standard', 'gap-4')}>
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
    </AreaStrings>
  );
}
