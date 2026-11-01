import type { ErrorComponentProps } from '@tanstack/react-router';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, pageClass } from './classes.ts';

/**
 * A render error in any screen must not leave a blank till. Data is already safe
 * (every write is a local transaction), so the only safe action is a reload.
 */
export function RouteError({ error }: ErrorComponentProps) {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <div
      className={`${pageClass('focused', 'gap-3')} items-center justify-center text-center`}
      role="alert"
      data-testid="route-error"
    >
      <h1 className="text-h1 font-semibold">{t('shell.error_title')}</h1>
      <p className="max-w-md text-center text-text-muted">
        {t('shell.error_body')}
      </p>
      <button
        type="button"
        className={buttonPrimary}
        onClick={() => {
          void router.invalidate();
          window.location.reload();
        }}
      >
        {t('shell.reload')}
      </button>
      {import.meta.env.DEV ? (
        <pre className="max-w-full overflow-auto text-small text-danger">
          {error instanceof Error ? error.message : String(error)}
        </pre>
      ) : null}
    </div>
  );
}
