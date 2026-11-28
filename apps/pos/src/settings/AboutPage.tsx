import { APP_VERSION } from '@bikri/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { InfoIcon } from '../components/icons.tsx';
import { loadCarts } from '../data/cart.ts';
import { getDb } from '../data/db.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { checkForUpdate, type UpdateCheck } from '../pwa/manualUpdate.ts';
import { useUpdateReady } from '../pwa/useUpdateReady.ts';
import { SettingsPageLayout } from './Layout.tsx';

/** About, version and the terms/privacy notes (screens/17, 09 §6.1). */
export function AboutPage() {
  return (
    <AreaStrings area="office">
      <AboutContent />
    </AreaStrings>
  );
}

function AboutContent() {
  const { t } = useTranslation();
  const { updateReady, applyUpdate } = useUpdateReady();
  const carts = useLiveQuery(() => loadCarts(getDb()), []);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<UpdateCheck | null>(null);

  // A reload would drop an open cart; held bills are already saved. Keep the
  // restart disabled until every cart is empty.
  const cartActive =
    carts === undefined ||
    Object.values(carts).some((cart) => cart.lines.length > 0);

  const check = async () => {
    if (checking) return;
    setChecking(true);
    setResult(null);
    try {
      setResult(await checkForUpdate());
    } catch {
      setResult('error');
    } finally {
      setChecking(false);
    }
  };

  const restart = () => {
    if (applying || cartActive) return;
    setApplying(true);
    applyUpdate();
    // If the controller never changes, let the button retry instead of staying
    // disabled forever.
    window.setTimeout(() => setApplying(false), 10_000);
  };

  return (
    <SettingsPageLayout title={t('office.about.title')} icon={<InfoIcon />}>
      <section className="flex flex-col gap-2 rounded-card border border-divider bg-surface p-4 text-small">
        <p>
          <span className="text-text-muted">{t('office.about.version')}: </span>
          <bdi dir="ltr" className="font-mono">
            {APP_VERSION}
          </bdi>
        </p>
        <p>
          <span className="text-text-muted">{t('office.about.build')}: </span>
          <bdi dir="ltr" className="font-mono">
            {__BUILD_ID__}
          </bdi>
        </p>
        <p className="text-text-muted">{t('office.about.built_note')}</p>

        {updateReady ? (
          <div className="flex flex-col gap-2 rounded-control border border-divider bg-surface-2 p-3">
            <p className="font-medium">{t('office.about.ready')}</p>
            <p className="text-text-muted">{t('office.about.restart_hint')}</p>
            <button
              type="button"
              className={`${buttonPrimary} self-start`}
              disabled={applying || cartActive}
              onClick={restart}
            >
              {applying
                ? t('office.about.restarting')
                : t('office.about.restart')}
            </button>
            {cartActive ? (
              <p className="text-text-muted">{t('office.about.sale_first')}</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonQuiet}
              disabled={checking}
              onClick={() => void check()}
            >
              {checking
                ? t('office.about.checking')
                : t('office.about.check_update')}
            </button>
          </div>
        )}

        {result === 'latest' && !updateReady ? (
          <p className="text-text-muted">{t('office.about.latest')}</p>
        ) : null}
        {result === 'offline' ? (
          <p className="text-text-muted">{t('office.about.offline')}</p>
        ) : null}
        {result === 'error' ? (
          <p className="text-danger">{t('office.about.error')}</p>
        ) : null}
        {result === 'unavailable' ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-text-muted">{t('office.about.unavailable')}</p>
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => window.location.reload()}
            >
              {t('office.about.reload')}
            </button>
          </div>
        ) : null}
      </section>
      <details className="rounded-card border border-divider bg-surface p-4">
        <summary className="min-h-11 cursor-pointer">
          <h2 className="inline text-title font-semibold">
            {t('office.about.terms')}
          </h2>
        </summary>
        <ol className="mt-2 flex list-decimal flex-col gap-2 ps-5 text-small">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((number) => (
            <li key={number}>{t(`office.about.terms_${number}`)}</li>
          ))}
        </ol>
      </details>
      <section className="flex flex-col gap-2 rounded-card border border-divider bg-surface p-4 text-small">
        <h2 className="text-title font-semibold">
          {t('office.about.privacy')}
        </h2>
        <p className="text-text-muted">{t('office.about.privacy_note')}</p>
      </section>
    </SettingsPageLayout>
  );
}
