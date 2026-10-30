import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsIcon } from '../components/icons.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { AreaStrings } from '../i18n/areas.tsx';
import { takeListScroll } from '../lib/listScroll.ts';
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
  const navRef = useRef<HTMLDivElement>(null);

  // Selecting a section is a route change, so SettingsNav remounts and the document height
  // briefly collapses. Keep the scroll of the nav on the desktop split; on smaller screens
  // the section is a full page and should start at its top.
  useLayoutEffect(() => {
    if (index) return;
    if (typeof window.matchMedia !== 'function') return;
    if (!window.matchMedia('(min-width: 1280px)').matches) {
      window.scrollTo(0, 0);
      return;
    }
    const y = takeListScroll();
    if (y <= 0) return;
    const root = document.documentElement;
    const previousMinHeight = root.style.minHeight;
    root.style.minHeight = `${y + window.innerHeight}px`;
    window.scrollTo(0, y);
    let frames = 0;
    const release = () => {
      frames += 1;
      if ((navRef.current?.scrollHeight ?? 0) >= y || frames > 30) {
        root.style.minHeight = previousMinHeight;
        return;
      }
      requestAnimationFrame(release);
    };
    requestAnimationFrame(release);
  }, [index]);

  return (
    <AreaStrings area="office">
      <div className="mx-auto w-full max-w-[1440px] p-4 xl:p-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)] xl:items-start">
          <div
            ref={navRef}
            className={index ? 'min-w-0' : 'min-w-0 max-xl:hidden'}
          >
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
