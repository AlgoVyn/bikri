import { useLocation, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useState } from 'react';
import { PageLoading } from '../components/PageLoading';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { SettingsPreview, SettingsSplit } from './Layout.tsx';

const ShopSettingsPage = lazy(() =>
  import('./ShopSettingsPage.tsx').then((module) => ({
    default: module.ShopSettingsPage,
  })),
);

const PrinterPage = lazy(() =>
  import('./PrinterPage.tsx').then((module) => ({
    default: module.PrinterPage,
  })),
);

/** The preview column exists only at xl; phones keep the index without mounting a section. */
function useDesktopPreview(): boolean {
  const [desktop, setDesktop] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(min-width: 1280px)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(min-width: 1280px)');
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return desktop;
}

/** Settings (screens/17): the index stays visible beside the selected section on desktop. */
export function SettingsHomePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { can } = useCurrentStaff();
  const desktopPreview = useDesktopPreview();
  // Open on a real section instead of an empty pane. Owners land on the shop profile;
  // everyone else lands on this device's printer settings, which every role can open.
  const defaultPath = can('settings.shop')
    ? '/settings/shop'
    : '/settings/printer';
  const DefaultPage =
    defaultPath === '/settings/shop' ? ShopSettingsPage : PrinterPage;

  useEffect(() => {
    if (location.hash === 'printer')
      void navigate({ to: '/settings/printer', replace: true });
  }, [location.hash, navigate]);

  return (
    <SettingsSplit index activePath={desktopPreview ? defaultPath : undefined}>
      {desktopPreview ? (
        <SettingsPreview>
          <Suspense fallback={<PageLoading compact />}>
            <DefaultPage />
          </Suspense>
        </SettingsPreview>
      ) : undefined}
    </SettingsSplit>
  );
}
