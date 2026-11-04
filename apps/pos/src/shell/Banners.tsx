import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { InfoIcon, LockIcon } from '../components/icons.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { getKv, setKv } from '../data/kv.ts';
import { useShopTimeZone } from '../data/useShopTimeZone.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useOnline } from './TopBarParts.tsx';

type TenantStatus = { status: string; since?: number; learned_at?: number };
type Support = { until: number; reason: string };

/** Offline, read-only (13 §7.2) and support-access (13 §7.5) banners on every screen. */
export function Banners() {
  const { t, i18n } = useTranslation();
  const timeZone = useShopTimeZone();
  const online = useOnline();
  const { staff, role } = useCurrentStaff();
  const toast = useToast();
  const state = useLiveQuery(async () => {
    const db = getDb();
    return {
      status: await getKv<TenantStatus | null>(db, 'tenant_status', null),
      support: await getKv<Support | null>(db, 'support', null),
      canEnd:
        role === 'owner' &&
        Boolean(
          (await getKv<{ is_admin?: boolean } | null>(db, 'device', null))
            ?.is_admin,
        ) &&
        Boolean(await getKv<string | null>(db, 'device_token', null)),
    };
  }, [role]);
  const endSupport = async () => {
    if (!staff) return;
    const db = getDb();
    try {
      const { shopRequest } = await import('../sync/shopApi.ts');
      const res = await shopRequest<{ ended: boolean }>(
        db,
        String(staff.id),
        '/support-access/end',
        {
          method: 'POST',
          json: {},
        },
      );
      if (res.ended) {
        await setKv(db, 'support', null);
        toast.push(t('tenant.support.ended'));
      }
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };
  const readOnly = state?.status?.status === 'read_only';
  const support =
    state?.support && state.support.until > Date.now() ? state.support : null;
  if (online && !readOnly && !support) return null;
  const time = support
    ? new Intl.DateTimeFormat(i18n.language === 'ur' ? 'ur-PK' : 'en-PK', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
      }).format(support.until)
    : '';
  return (
    <div className="flex flex-col">
      {readOnly ? (
        <p
          role="alert"
          data-testid="banner-read-only"
          className="flex min-h-11 items-center gap-2 bg-warning-subtle px-4 py-2 text-small text-warning-subtle-ink"
        >
          <span aria-hidden="true" className="shrink-0">
            <LockIcon />
          </span>
          {t('tenant.readOnly.banner')}
        </p>
      ) : null}
      {support ? (
        <p
          role="status"
          data-testid="banner-support"
          className="flex min-h-11 items-center gap-2 bg-info-subtle px-4 py-2 text-small text-info-subtle-ink"
        >
          <span aria-hidden="true" className="shrink-0">
            <InfoIcon />
          </span>
          {t('tenant.support.banner', { time, reason: support.reason })}
          {state?.canEnd ? (
            <button
              type="button"
              className="ms-2 underline"
              onClick={() => void endSupport()}
            >
              {t('tenant.support.end_now')}
            </button>
          ) : null}
        </p>
      ) : null}
      {online ? null : (
        <p
          role="status"
          data-testid="banner-offline"
          className="flex min-h-11 items-center gap-2 bg-warning-subtle px-4 py-2 text-small text-warning-subtle-ink"
        >
          <span aria-hidden="true" className="shrink-0">
            <InfoIcon />
          </span>
          {t('shell.offline')}
        </p>
      )}
    </div>
  );
}
