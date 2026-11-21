import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from './app.tsx';
import { initI18n } from './i18n/i18n.ts';
import { rememberPersistentStorage } from './pwa/persist.ts';
import { registerAppUpdate } from './pwa/registerSW.ts';
import './styles.css';

// Register on load/idle: the service worker precaches ~2.4 MB, and the first visit should
// not compete with the shell, the locale chunk and the first sync for bandwidth.
const registerWhenIdle = () => {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => registerAppUpdate(), { timeout: 3_000 });
  } else {
    window.setTimeout(registerAppUpdate, 1_500);
  }
};

/**
 * Start after the active catalog is loaded. This used to be a top-level await; moving
 * it into a function keeps the entry module free of a pending evaluation, so a chunk
 * that imports the entry's shared chunk can never deadlock behind the locale import.
 */
async function start(): Promise<void> {
  await initI18n();
  if (import.meta.env.DEV || import.meta.env.VITE_LOCAL_TENANT === 'dev') {
    const { installTestHooks } = await import('./dev/testHooks.ts');
    installTestHooks();
  }
  if (document.readyState === 'complete') registerWhenIdle();
  else window.addEventListener('load', registerWhenIdle, { once: true });
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
}

void start();
