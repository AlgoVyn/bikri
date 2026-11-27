import { registerSW } from 'virtual:pwa-register';
import { startUpdateChecks } from './updateCheck.ts';
import { setUpdateReady } from './updateStore.ts';

/** Registers the prompt-mode service worker. Reload happens only when the user taps. */
export function registerAppUpdate(): void {
  const apply = registerSW({
    immediate: true,
    onNeedRefresh() {
      setUpdateReady(true, () => {
        void apply(true);
      });
    },
  });
  // The registration itself fetches sw.js; do not immediately fetch it a second time.
  startUpdateChecks({ skipStartupCheck: true });
}
