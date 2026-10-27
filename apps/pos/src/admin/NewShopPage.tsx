import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import { adminErrorMessage, createTenant, slugAvailable } from './api.ts';
import {
  adminHref,
  DEFAULT_WRITE_BUDGET,
  EMAIL_RE,
  SLUG_RE,
} from './format.ts';
import type { IssuedCode } from './types.ts';
import { Field, PairingPanel, primaryBtn, quietBtn } from './ui.tsx';

type SlugState = 'idle' | 'checking' | 'free' | 'taken' | 'invalid';

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
      <div className="flex flex-col gap-4">
        <h1 className="text-title font-semibold">{t('admin.new_title')}</h1>
        <PairingPanel
          code={issued.code.code}
          link={issued.code.link}
          expiresAt={issued.code.expires_at}
          shopName={issued.shop}
        />
        <a href={adminHref('/admin/tenants')} className={quietBtn}>
          {t('admin.back_to_shops')}
        </a>
      </div>
    );
  }

  return (
    <form
      className="flex max-w-xl flex-col gap-4"
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
            setIssued({ code: result.owner_code, shop: display });
          })
          .catch((err: unknown) => {
            toast.push(adminErrorMessage(err, t('admin.err_generic')), 'error');
          })
          .finally(() => {
            setPending(false);
          });
      }}
    >
      <h1 className="text-title font-semibold">{t('admin.new_title')}</h1>
      <Field id="shop-name" label={t('admin.display_name')}>
        <input
          id="shop-name"
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-3"
          value={name}
          maxLength={60}
          required
          autoComplete="off"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
      <Field id="shop-slug" label={t('admin.slug')} hint={t('admin.slug_hint')}>
        <input
          id="shop-slug"
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-3 font-mono"
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
      <p aria-live="polite" className="text-small">
        {slugState === 'checking' ? t('admin.slug_checking') : null}
        {slugState === 'free' ? t('admin.slug_free') : null}
        {slugState === 'taken' ? t('admin.slug_taken') : null}
        {slugState === 'invalid' ? t('admin.slug_invalid') : null}
      </p>
      <Field
        id="shop-email"
        label={t('admin.owner_email')}
        hint={t('admin.owner_email_hint')}
      >
        <input
          id="shop-email"
          type="email"
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-3"
          value={email}
          maxLength={254}
          autoComplete="off"
          aria-describedby="shop-email-hint"
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
      </Field>
      <Field id="shop-budget" label={t('admin.budget')}>
        <input
          id="shop-budget"
          inputMode="numeric"
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-3 font-mono"
          value={budget}
          onChange={(event) => {
            setBudget(event.target.value);
          }}
        />
      </Field>
      {!budgetOk ? (
        <p className="text-small text-danger">{t('admin.err_budget')}</p>
      ) : null}
      <Field id="shop-note" label={t('admin.note')}>
        <textarea
          id="shop-note"
          className="min-h-24 w-full rounded-control border border-border-strong bg-surface px-3 py-2"
          maxLength={500}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
      <button
        type="submit"
        className={primaryBtn}
        disabled={!canCreate || pending}
      >
        {t('admin.create')}
      </button>
    </form>
  );
}
