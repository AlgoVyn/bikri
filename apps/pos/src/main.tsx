import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from './app.tsx';
import { initI18n } from './i18n/i18n.ts';
import { rememberPersistentStorage } from './pwa/persist.ts';
import { registerAppUpdate } from './pwa/registerSW.ts';
import './styles.css';

await initI18n();
if (import.meta.env.DEV || import.meta.env.VITE_LOCAL_TENANT === 'dev') {
  const { installTestHooks } = await import('./dev/testHooks.ts');
  installTestHooks();
}
registerAppUpdate();
void rememberPersistentStorage();

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root is missing');
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
