import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary } from '../components/classes.ts';
import {
  HomeIcon,
  ProductsIcon,
  SalesIcon,
  SellIcon,
  SettingsIcon,
  UdhaarIcon,
} from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { isLocale, setLanguage } from '../i18n/i18n.ts';
import { useUpdateReady } from '../pwa/useUpdateReady.ts';

const NAV = [
  { to: '/', label: 'nav.home', keys: 'Alt+1', Icon: HomeIcon },
  { to: '/sell', label: 'nav.sell', keys: 'Alt+2', Icon: SellIcon },
  { to: '/products', label: 'nav.products', keys: 'Alt+3', Icon: ProductsIcon },
  { to: '/sales', label: 'nav.sales', keys: 'Alt+4', Icon: SalesIcon },
  { to: '/udhaar', label: 'nav.udhaar', keys: 'Alt+5', Icon: UdhaarIcon },
  { to: '/settings', label: 'nav.settings', keys: 'Alt+6', Icon: SettingsIcon },
] as const;

function ignoresHotkey(target: EventTarget | null): boolean {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return true;
  }
  if (target instanceof HTMLSelectElement) {
    return true;
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { updateReady, applyUpdate } = useUpdateReady();
  const language = isLocale(i18n.language) ? i18n.language : 'en';

  useEffect(() => {
    document.title = t('common.app_title');
  }, [t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (ignoresHotkey(event.target)) {
        return;
      }
      const match = /^Digit([1-6])$/u.exec(event.code);
      const digit = match?.[1];
      if (digit === undefined) {
        return;
      }
      const item = NAV[Number(digit) - 1];
      if (item === undefined) {
        return;
      }
      event.preventDefault();
      void navigate({ to: item.to });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [navigate]);

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="fixed start-0 end-0 top-0 z-30 flex h-topbar items-center gap-3 border-b border-border bg-surface px-3 lg:start-rail">
        <span className="font-medium">{t('common.app_name')}</span>
        <div className="ms-auto flex items-center gap-2">
          {updateReady ? (
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => {
                applyUpdate();
              }}
            >
              {t('shell.update_ready')}
            </button>
          ) : null}
          {import.meta.env.DEV ? (
            <Link to="/dev/ui" className="text-small text-primary">
              {t('shell.ui_kit')}
            </Link>
          ) : null}
          <label className="inline-flex items-center">
            <span className="sr-only">{t('shell.language')}</span>
            <select
              className="h-11 rounded-control border border-border-strong bg-surface px-2 text-text"
              value={language}
              onChange={(event) => {
                const next = event.target.value;
                if (isLocale(next)) {
                  void setLanguage(next);
                }
              }}
            >
              <option value="en">{t('shell.lang_en')}</option>
              <option value="ur">{t('shell.lang_ur')}</option>
              <option value="roman-ur">{t('shell.lang_roman_ur')}</option>
            </select>
          </label>
        </div>
      </header>
      <nav
        aria-label={t('nav.rail')}
        className="fixed z-30 flex border-border bg-surface max-lg:inset-x-0 max-lg:bottom-0 max-lg:h-tabbar max-lg:items-stretch max-lg:justify-around max-lg:border-t lg:inset-y-0 lg:start-0 lg:w-rail lg:flex-col lg:border-e"
      >
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: true }}
            className="flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-small text-text-muted aria-[current=page]:text-primary lg:flex-none lg:py-2"
          >
            <item.Icon />
            <span className="max-w-full truncate">{t(item.label)}</span>
            <KeyBadge keys={item.keys} />
          </Link>
        ))}
      </nav>
      <main className="pt-topbar pb-tabbar lg:ps-rail lg:pb-0">{children}</main>
    </div>
  );
}
