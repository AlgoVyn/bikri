import { registerSW } from 'virtual:pwa-register';
import { startUpdateChecks } from './updateCheck.ts';
import { setApplyUpdate, setUpdateReady } from './updateStore.ts';

/** Registers the prompt-mode service worker. Reload happens only when the user taps. */
export function registerAppUpdate(): void {
  const apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      setUpdateReady(true);
    },
  });
  // Keep the apply function before a worker is waiting: the About page can find a
  // waiting worker itself (for example after a manual check) and still restart.
  setApplyUpdate(() => void apply(true));
  // The registration itself fetches sw.js; do not immediately fetch it a second time.
  startUpdateChecks({ skipStartupCheck: true });
}
