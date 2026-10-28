import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StoreIcon } from '../components/icons.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import { adminErrorMessage, createTenant, slugAvailable } from './api.ts';
import {
  adminHref,
  DEFAULT_WRITE_BUDGET,
  EMAIL_RE,
  SLUG_RE,
} from './format.ts';
import type { IssuedCode } from './types.ts';
import {
  Field,
  inputClass,
  PairingPanel,
  Panel,
  primaryBtn,
  quietBtn,
} from './ui.tsx';

type SlugState = 'idle' | 'checking' | 'free' | 'taken' | 'invalid';

const STEPS = [
  'admin.new_side_1',
  'admin.new_side_2',
  'admin.new_side_3',
  'admin.new_side_4',
] as const;

export function NewShopPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [budget, setBudget] = useState(String(DEFAULT_WRITE_BUDGET));
  const [note, setNote] = useState('');
  const [slugState, setSlugState] = useState<SlugState>('idle');
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<{
    code: IssuedCode;
    shop: string;
    tenantId: string;
  } | null>(null);

  useEffect(() => {
    if (!SLUG_RE.test(slug)) {
      setSlugState(slug === '' ? 'idle' : 'invalid');
      return;
    }
    setSlugState('checking');
    let cancelled = false;
    const handle = setTimeout(() => {
      void slugAvailable(slug)
        .then((result) => {
          if (!cancelled) setSlugState(result.available ? 'free' : 'taken');
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setSlugState('invalid');
          toast.push(adminErrorMessage(err, t('admin.err_generic')), 'error');
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [slug, t, toast]);

  const budgetN = Number(budget);
  const budgetOk =
    Number.isInteger(budgetN) && budgetN >= 0 && budgetN <= 100_000;
  const emailOk =
    email.trim() === '' || EMAIL_RE.test(email.trim().toLowerCase());
  const nameOk = name.trim().length >= 1 && name.trim().length <= 60;
  const canCreate =
    nameOk && slugState === 'free' && emailOk && budgetOk && note.length <= 500;

  if (issued !== null) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          icon={<StoreIcon />}
          title={issued.shop}
          subtitle={t('admin.created_hint')}
          actions={
            <a
              href={adminHref(`/admin/tenants/${issued.tenantId}`)}
              className={primaryBtn}
            >
              {t('admin.open_shop')}
            </a>
          }
        />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
          <PairingPanel
            code={issued.code.code}
            link={issued.code.link}
            expiresAt={issued.code.expires_at}
            shopName={issued.shop}
          />
          <Panel title={t('admin.new_side_title')}>
            <ol className="flex flex-col gap-3">
              {STEPS.map((key, index) => (
                <li key={key} className="flex gap-3 text-small">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-subtle font-semibold text-primary-subtle-ink">
                    {index + 1}
                  </span>
                  <span>{t(key)}</span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
        <div>
          <a href={adminHref('/admin/tenants')} className={quietBtn}>
            {t('admin.back_to_shops')}
          </a>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canCreate || pending) return;
        setPending(true);
        const display = name.trim();
        void createTenant({
          slug,
          display_name: display,
          daily_write_budget: budgetN,
          note,
          ...(email.trim() === ''
            ? {}
            : { owner_email: email.trim().toLowerCase() }),
        })
          .then((result) => {
            setIssued({
              code: result.owner_code,
              shop: display,
              tenantId: result.tenant.id,
            });
          })
          .catch((err: unknown) => {
            toast.push(adminErrorMessage(err, t('admin.err_generic')), 'error');
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      <PageHeader
        icon={<StoreIcon />}
        title={t('admin.new_title')}
        subtitle={t('admin.new_subtitle')}
        actions={
          <a href={adminHref('/admin/tenants')} className={quietBtn}>
            {t('admin.back_to_shops')}
          </a>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <Panel
          title={t('admin.new_details')}
          description={t('admin.new_details_hint')}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field id="shop-name" label={t('admin.display_name')}>
                <input
                  id="shop-name"
                  className={inputClass}
                  value={name}
                  maxLength={60}
                  required
                  autoComplete="off"
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field
                id="shop-slug"
                label={t('admin.slug')}
                hint={t('admin.slug_hint')}
              >
                <input
                  id="shop-slug"
                  className={`${inputClass} font-mono`}
                  value={slug}
                  maxLength={30}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="shop-slug-hint"
                  onChange={(event) => {
                    setSlug(event.target.value.trim().toLowerCase());
                  }}
                />
              </Field>
              <p aria-live="polite" className="mt-1 text-small">
                {slugState === 'checking' ? (
                  <span className="text-text-muted">
                    {t('admin.slug_checking')}
                  </span>
                ) : null}
                {slugState === 'free' ? (
                  <span className="text-success-subtle-ink">
                    {t('admin.slug_free')}
                  </span>
                ) : null}
                {slugState === 'taken' ? (
                  <span className="text-danger">{t('admin.slug_taken')}</span>
                ) : null}
                {slugState === 'invalid' ? (
                  <span className="text-danger">{t('admin.slug_invalid')}</span>
                ) : null}
              </p>
            </div>
            <div className="sm:col-span-2">
              <Field
                id="shop-email"
                label={t('admin.owner_email')}
                hint={t('admin.owner_email_hint')}
              >
                <input
                  id="shop-email"
                  type="email"
                  className={inputClass}
                  value={email}
                  maxLength={254}
                  autoComplete="off"
                  aria-describedby="shop-email-hint"
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                />
              </Field>
            </div>
            <Field id="shop-budget" label={t('admin.budget')}>
              <input
                id="shop-budget"
                inputMode="numeric"
                className={`${inputClass} font-mono`}
                value={budget}
                onChange={(event) => {
                  setBudget(event.target.value);
                }}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field id="shop-note" label={t('admin.note')}>
                <textarea
                  id="shop-note"
                  className="min-h-24 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-text focus:border-primary"
                  maxLength={500}
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                />
              </Field>
              <p className="mt-1 text-end text-small text-text-muted tabular-nums">
                {note.length} / 500
              </p>
            </div>
          </div>
          {!budgetOk ? (
            <p className="mt-3 text-small text-danger" role="alert">
              {t('admin.err_budget')}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
            <button
              type="submit"
              className={primaryBtn}
              disabled={!canCreate || pending}
            >
              {t('admin.create')}
            </button>
            <a href={adminHref('/admin/tenants')} className={quietBtn}>
              {t('common.cancel')}
            </a>
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          <Panel title={t('admin.new_side_title')}>
            <ol className="flex flex-col gap-3">
              {STEPS.map((key, index) => (
                <li key={key} className="flex gap-3 text-small">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-subtle font-semibold text-primary-subtle-ink">
                    {index + 1}
                  </span>
                  <span>{t(key)}</span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </form>
  );
}
