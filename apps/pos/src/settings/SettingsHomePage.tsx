import { useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { SettingsIndex } from './Layout.tsx';

/** Settings (screens/17): one centred index; a row opens that section's own page. */
export function SettingsHomePage() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (location.hash === 'printer')
      void navigate({ to: '/settings/printer', replace: true });
  }, [location.hash, navigate]);

  return <SettingsIndex />;
}
