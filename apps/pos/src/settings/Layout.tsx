import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsIcon } from '../components/icons.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { AreaStrings } from '../i18n/areas.tsx';
import { SettingsNav } from './SettingsNav.tsx';

/**
 * Settings on ≥1280 px uses the reference app's master–detail split: the index stays on the
 * start side and the selected section fills the end side. Below that, a section is a full page.
 */
export function SettingsSplit({
  index = false,
  children,
}: {
  index?: boolean;
  children?: ReactNode;
}) {
  return (
    <AreaStrings area="office">
      <div className="mx-auto w-full max-w-[1440px] p-4 xl:p-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)] xl:items-start">
          <div className={index ? 'min-w-0' : 'min-w-0 max-xl:hidden'}>
            <SettingsNav />
          </div>
          <div className={index ? 'hidden min-w-0 xl:block' : 'min-w-0'}>
            {index ? <SettingsPlaceholder /> : children}
          </div>
        </div>
      </div>
    </AreaStrings>
  );
}

function SettingsPlaceholder() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[32rem] flex-col items-center justify-center gap-3 rounded-card border border-border bg-surface p-8 text-center shadow-card">
      <span
        aria-hidden="true"
        className="flex size-14 items-center justify-center rounded-full bg-surface text-text-muted"
      >
        <SettingsIcon />
      </span>
      <p className="text-title font-semibold">{t('office.settings.choose')}</p>
      <p className="max-w-xs text-small text-text-muted">
        {t('office.settings.choose_hint')}
      </p>
    </div>
  );
}

/** Shared Settings subpage frame with the split index, a back link and title. */
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
    <SettingsSplit>
      <div className="flex min-w-0 flex-col gap-4">
        <SubpageHeader
          backTo="/settings"
          backLabel={t('common.back')}
          icon={icon ?? <SettingsIcon />}
          title={title}
        />
        {children}
      </div>
    </SettingsSplit>
  );
}
