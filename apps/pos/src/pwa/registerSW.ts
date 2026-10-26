import { registerSW } from 'virtual:pwa-register';
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
}
