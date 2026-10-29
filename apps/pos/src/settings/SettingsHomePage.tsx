import { useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { SettingsSplit } from './Layout.tsx';

/** Settings (screens/17): the index stays visible beside the selected section on desktop. */
export function SettingsHomePage() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (location.hash === 'printer')
      void navigate({ to: '/settings/printer', replace: true });
  }, [location.hash, navigate]);
  return <SettingsSplit index />;
}
