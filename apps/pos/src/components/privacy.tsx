import { createContext, type ReactNode, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { EyeOffIcon } from './icons.tsx';

/**
 * Privacy mode (screens/04): hide amounts on this device from anyone looking at the
 * screen. The values are not rendered at all while active, so blurring, screenshotting
 * or inspecting the DOM cannot reveal them. This is shoulder-surfing privacy, not access
 * control; the selling flow and every printed/exported output stay readable.
 */
const PrivacyContext = createContext(false);

export function PrivacyProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <PrivacyContext.Provider value={active}>{children}</PrivacyContext.Provider>
  );
}

export function usePrivacyActive(): boolean {
  return useContext(PrivacyContext);
}

/** Drop-in inline value that becomes a fixed-width mask while privacy mode is active. */
export function PrivacyValue({
  children,
  mask = '••••',
  className,
}: {
  children: ReactNode;
  mask?: string;
  className?: string;
}) {
  const active = usePrivacyActive();
  const { t } = useTranslation();
  if (!active) return <>{children}</>;
  return (
    <bdi dir="ltr" className={className}>
      <span className="sr-only">{t('privacy.hidden')}</span>
      <span aria-hidden="true">{mask}</span>
    </bdi>
  );
}

/** Replaces a chart plot (bar heights/tooltips leak performance even without labels). */
export function PrivacyCurtain({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="img"
      aria-label={`${t('privacy.chart_hidden')}. ${t('privacy.chart_hint')}`}
      className={`flex min-h-40 flex-col items-center justify-center gap-2 rounded-card border border-border bg-surface p-6 text-center ${className}`}
    >
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-full bg-surface-2 text-text-muted"
      >
        <EyeOffIcon />
      </span>
      <p className="text-small text-text-muted">
        {t('privacy.chart_hidden')}
        <span className="block text-small">{t('privacy.chart_hint')}</span>
      </p>
    </div>
  );
}
