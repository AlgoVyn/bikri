import { createFileRoute, Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

export const Route = createFileRoute('/settings/')({
  component: SettingsPage,
});

/** Settings (screens/17). M1 has the device's printer; the other sections arrive with their tasks. */
function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-h1 font-semibold">{t('nav.settings')}</h1>
      <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
        <li>
          <Link
            to="/settings/printer"
            className="flex min-h-14 flex-col justify-center p-3"
          >
            <span className="font-medium">{t('printer.title')}</span>
            <span className="text-small text-text-muted">
              {t('settings.printer_hint')}
            </span>
          </Link>
        </li>
        <li className="flex min-h-14 flex-col justify-center p-3 text-text-muted">
          <span>{t('settings.more')}</span>
          <span className="text-small">{t('common.coming_soon')}</span>
        </li>
      </ul>
    </div>
  );
}
