import { APP_VERSION } from '@bikri/core';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from '../components/classes.ts';
import { useToast } from '../components/Toast.tsx';
import { AreaStrings } from '../i18n/areas.tsx';
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
  const toast = useToast();
  const check = async () => {
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (registration) {
        await registration.update();
        toast.push(t('office.about.updated'));
      } else {
        window.location.reload();
      }
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };
  return (
    <SettingsPageLayout title={t('office.about.title')}>
      <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4 text-small">
        <p>
          <span className="text-text-muted">{t('office.about.version')}: </span>
          <bdi dir="ltr" className="font-mono">
            {APP_VERSION}
          </bdi>
        </p>
        <p className="text-text-muted">{t('office.about.built_note')}</p>
        <div className="flex flex-wrap gap-2">
          <a
            className={buttonQuiet}
            href="https://github.com/AlgoVyn/bikri"
            target="_blank"
            rel="noreferrer"
          >
            {t('office.about.source')}
          </a>
          <a
            className={buttonQuiet}
            href="https://github.com/AlgoVyn/bikri/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer"
          >
            {t('office.about.license')}
          </a>
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => void check()}
          >
            {t('office.about.check_update')}
          </button>
        </div>
      </section>
      <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
        <h2 className="text-title font-semibold">{t('office.about.terms')}</h2>
        <ol className="flex list-decimal flex-col gap-2 ps-5 text-small">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((number) => (
            <li key={number}>{t(`office.about.terms_${number}`)}</li>
          ))}
        </ol>
      </section>
      <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4 text-small">
        <h2 className="text-title font-semibold">
          {t('office.about.privacy')}
        </h2>
        <p className="text-text-muted">{t('office.about.privacy_note')}</p>
      </section>
    </SettingsPageLayout>
  );
}
