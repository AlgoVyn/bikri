import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { getDb } from '../data/db.ts';
import { getKv } from '../data/kv.ts';
import { useOnline } from './TopBarParts.tsx';

type TenantStatus = { status: string; since?: number; learned_at?: number };
type Support = { until: number; reason: string };

/** Offline, read-only (13 §7.2) and support-access (13 §7.5) banners on every screen. */
export function Banners() {
  const { t, i18n } = useTranslation();
  const online = useOnline();
  const state = useLiveQuery(async () => {
    const db = getDb();
    return {
      status: await getKv<TenantStatus | null>(db, 'tenant_status', null),
      support: await getKv<Support | null>(db, 'support', null),
    };
  }, []);
  const readOnly = state?.status?.status === 'read_only';
  const support =
    state?.support && state.support.until > Date.now() ? state.support : null;
  if (online && !readOnly && !support) return null;
  const time = support
    ? new Intl.DateTimeFormat(i18n.language === 'ur' ? 'ur-PK' : 'en-PK', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Karachi',
      }).format(support.until)
    : '';
  return (
    <div className="flex flex-col">
      {readOnly ? (
        <p
          role="alert"
          data-testid="banner-read-only"
          className="bg-warning-subtle px-4 py-2 text-warning-subtle-ink"
        >
          {t('tenant.readOnly.banner')}
        </p>
      ) : null}
      {support ? (
        <p
          role="status"
          data-testid="banner-support"
          className="bg-info-subtle px-4 py-2 text-info-subtle-ink"
        >
          {t('tenant.support.banner', { time, reason: support.reason })}
        </p>
      ) : null}
      {online ? null : (
        <p
          role="status"
          data-testid="banner-offline"
          className="bg-warning-subtle px-4 py-1 text-small text-warning-subtle-ink"
        >
          {t('shell.offline')}
        </p>
      )}
    </div>
  );
}
