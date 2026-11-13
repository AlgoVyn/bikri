import { API_BASE, BASE_PATH } from '@bikri/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BikriMark } from '../components/BikriMark.tsx';
import { buttonQuiet } from '../components/classes.ts';
import { StoreIcon } from '../components/icons.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { AreaStrings } from '../i18n/areas.tsx';

type Status =
  | 'pending'
  | 'awaiting_email'
  | 'email_verified'
  | 'approving'
  | 'approved'
  | 'rejected'
  | 'failed';

type PublicStatus = {
  shop_name: string;
  email: string;
  status: Status;
  created_at: number;
  email_verified_at: number | null;
  reject_reason: string;
};

const LABEL: Record<Status, string> = {
  pending: 'register.status_pending',
  awaiting_email: 'register.status_awaiting_email',
  email_verified: 'register.status_email_verified',
  approving: 'register.status_pending',
  approved: 'register.status_approved',
  rejected: 'register.status_rejected',
  failed: 'register.status_pending',
};

export function RequestStatusPage() {
  return (
    <AreaStrings area="public">
      <RequestStatus />
    </AreaStrings>
  );
}

function RequestStatus() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'missing' }
    | { kind: 'error' }
    | { kind: 'ok'; data: PublicStatus }
  >({ kind: 'loading' });

  useEffect(() => {
    const token = window.location.hash.replace(/^#/u, '');
    if (!token) {
      setState({ kind: 'missing' });
      return;
    }
    let alive = true;
    void fetch(`${API_BASE}/public/shop-requests/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        if (!alive) return;
        if (response.status === 404) {
          setState({ kind: 'missing' });
          return;
        }
        if (!response.ok) {
          setState({ kind: 'error' });
          return;
        }
        setState({ kind: 'ok', data: (await response.json()) as PublicStatus });
      })
      .catch(() => {
        if (alive) setState({ kind: 'error' });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-5 p-4 py-10">
      <header className="flex items-center gap-3">
        <BikriMark className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="text-h2 font-semibold tracking-wordmark">
            {t('common.app_name')}
          </p>
          <p className="flex items-center gap-1.5 text-small text-text-muted">
            <StoreIcon /> {t('register.brand')}
          </p>
        </div>
        <LanguageSelect />
      </header>

      <section className="rounded-card border border-border bg-surface p-5 shadow-card">
        {state.kind === 'loading' ? (
          <p className="text-text-muted">{t('common.loading')}</p>
        ) : state.kind === 'missing' ? (
          <div data-testid="register-status-missing">
            <h1 className="text-h1 font-semibold">
              {t('register.status_missing_title')}
            </h1>
            <p className="mt-2 text-text-muted">
              {t('register.status_missing_body')}
            </p>
          </div>
        ) : state.kind === 'error' ? (
          <div data-testid="register-status-error">
            <h1 className="text-h1 font-semibold">
              {t('register.status_error_title')}
            </h1>
            <p className="mt-2 text-text-muted">
              {t('register.status_error_body')}
            </p>
          </div>
        ) : (
          <div data-testid="register-status">
            <h1 className="text-h1 font-semibold">
              {t('register.status_title')}
            </h1>
            <p className="mt-2 text-text-muted">
              {state.data.shop_name} · {state.data.email}
            </p>
            <p
              data-testid="register-status-label"
              className="mt-4 rounded-control bg-primary-subtle p-3 font-medium text-primary-subtle-ink"
            >
              {t(LABEL[state.data.status])}
            </p>
            {state.data.status === 'rejected' && state.data.reject_reason ? (
              <p className="mt-2 text-small text-text-muted">
                {t('register.status_reason', {
                  reason: state.data.reject_reason,
                })}
              </p>
            ) : null}
            <p className="mt-2 text-small text-text-muted">
              {t('register.status_created', {
                date: new Intl.DateTimeFormat(
                  i18n.language === 'ur' ? 'ur-PK' : 'en-GB',
                  {
                    timeZone: 'Asia/Karachi',
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  },
                ).format(state.data.created_at),
              })}
            </p>
          </div>
        )}
        <a
          className={`${buttonQuiet} mt-5 inline-flex`}
          href={`${BASE_PATH}/request`}
        >
          {t('register.status_back')}
        </a>
      </section>
    </main>
  );
}
