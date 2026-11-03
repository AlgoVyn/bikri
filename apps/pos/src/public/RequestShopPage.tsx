import { API_BASE, BASE_PATH } from '@bikri/core';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BikriMark } from '../components/BikriMark.tsx';
import { buttonPrimary, fieldClass } from '../components/classes.ts';
import { StoreIcon } from '../components/icons.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { useToast } from '../components/Toast.tsx';
import { AreaStrings } from '../i18n/areas.tsx';

type FormState = {
  shop_name: string;
  owner_name: string;
  email: string;
  phone: string;
  city: string;
  business_type: string;
  note: string;
  website: string;
};

const EMPTY: FormState = {
  shop_name: '',
  owner_name: '',
  email: '',
  phone: '',
  city: '',
  business_type: 'mobile',
  note: '',
  website: '',
};

export function RequestShopPage() {
  return (
    <AreaStrings area="public">
      <RequestShop />
    </AreaStrings>
  );
}

function RequestShop() {
  const { t } = useTranslation();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  const set = (key: keyof FormState, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`${API_BASE}/public/shop-requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = (await response.json().catch(() => null)) as {
        status_token?: unknown;
      } | null;
      if (response.status === 202) {
        setToken(
          typeof body?.status_token === 'string' ? body.status_token : null,
        );
        return;
      }
      toast.push(
        response.status === 429
          ? t('register.error_rate')
          : t('register.error_generic'),
        'error',
      );
    } catch {
      toast.push(t('register.error_generic'), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (token !== null) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-5 p-4 py-10">
        <Brand />
        <section
          data-testid="register-success"
          className="rounded-card border border-border bg-surface p-5 shadow-card"
        >
          <h1 className="text-h1 font-semibold">
            {t('register.success_title')}
          </h1>
          <p className="mt-2 text-text-muted">{t('register.success_body')}</p>
          <a
            data-testid="register-status-link"
            className={`${buttonPrimary} mt-5 inline-flex`}
            href={`${BASE_PATH}/request-status#${encodeURIComponent(token)}`}
          >
            {t('register.check_status')}
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-5 p-4 py-10">
      <Brand />
      <form
        className="flex flex-col gap-4 rounded-card border border-border bg-surface p-5 shadow-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <h1 className="text-h1 font-semibold">{t('register.title')}</h1>
          <p className="mt-2 text-text-muted">{t('register.subtitle')}</p>
          <p className="mt-2 rounded-control bg-surface-2 p-3 text-small text-text-muted">
            {t('register.intro')}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-small sm:col-span-2">
            <span>{t('register.shop_name')}</span>
            <input
              data-testid="register-shop-name"
              className={fieldClass}
              required
              maxLength={60}
              value={form.shop_name}
              onChange={(event) => set('shop_name', event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-small">
            <span>{t('register.owner_name')}</span>
            <input
              data-testid="register-owner-name"
              className={fieldClass}
              required
              maxLength={60}
              value={form.owner_name}
              onChange={(event) => set('owner_name', event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-small">
            <span>{t('register.email')}</span>
            <input
              data-testid="register-email"
              className={fieldClass}
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              value={form.email}
              onChange={(event) => set('email', event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-small">
            <span>{t('register.phone')}</span>
            <input
              data-testid="register-phone"
              className={fieldClass}
              maxLength={30}
              autoComplete="tel"
              value={form.phone}
              onChange={(event) => set('phone', event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-small">
            <span>{t('register.city')}</span>
            <input
              data-testid="register-city"
              className={fieldClass}
              maxLength={60}
              value={form.city}
              onChange={(event) => set('city', event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-small sm:col-span-2">
            <span>{t('register.business_type')}</span>
            <select
              data-testid="register-business-type"
              className={fieldClass}
              value={form.business_type}
              onChange={(event) => set('business_type', event.target.value)}
            >
              <option value="mobile">{t('register.business_mobile')}</option>
              <option value="grocery">{t('register.business_grocery')}</option>
              <option value="other">{t('register.business_other')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-small sm:col-span-2">
            <span>{t('register.note')}</span>
            <textarea
              data-testid="register-note"
              className={`${fieldClass} min-h-24 resize-y`}
              maxLength={500}
              value={form.note}
              onChange={(event) => set('note', event.target.value)}
            />
          </label>
        </div>
        <label className="sr-only" aria-hidden="true">
          Website
          <input
            tabIndex={-1}
            autoComplete="off"
            value={form.website}
            onChange={(event) => set('website', event.target.value)}
          />
        </label>
        <p className="text-small text-text-muted">{t('register.privacy')}</p>
        <button
          type="submit"
          data-testid="register-submit"
          className={buttonPrimary}
          disabled={busy}
        >
          {busy ? t('register.submitting') : t('register.submit')}
        </button>
      </form>
    </main>
  );
}

function Brand() {
  const { t } = useTranslation();
  return (
    <header className="flex items-center gap-3">
      <span className="flex size-10 items-center justify-center rounded-control bg-primary-subtle text-primary-subtle-ink">
        <BikriMark className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-small font-semibold uppercase tracking-[0.14em] text-text-muted">
          {t('common.app_name')}
        </p>
        <p className="flex items-center gap-1.5 text-small text-text-muted">
          <StoreIcon /> {t('register.brand')}
        </p>
      </div>
      <LanguageSelect />
    </header>
  );
}
