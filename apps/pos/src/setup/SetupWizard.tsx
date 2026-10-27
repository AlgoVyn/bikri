import {
  generateSku,
  isWeakPin,
  normaliseNumericText,
  parsePkPhone,
} from '@bikri/core';
import { useNavigate } from '@tanstack/react-router';
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { PhoneInput } from '../components/PhoneInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { tenantInfo } from '../data/localTenant.ts';
import {
  BUSINESS_TYPES,
  type BusinessType,
  DEFAULT_FOOTER,
  finishSetup,
  loadSetupDraft,
  ROUND_OPTIONS,
  SetupAlreadyDoneError,
  type SetupDraft,
  type SetupInput,
  saveSetupDraft,
} from '../data/setup.ts';
import { isLocale, setLanguage } from '../i18n/i18n.ts';
import { useSession } from '../state/session.ts';
import { LogoError, type ProcessedLogo, processLogo } from './logo.ts';
import { PinBoxes } from './PinBoxes.tsx';
import { ReceiptPreview } from './ReceiptPreview.tsx';

type Step = 0 | 1 | 2 | 3 | 4;
type Errors = Record<string, string>;
type ProductDraft = {
  name: string;
  sku: string;
  barcode: string;
  cost: number;
  price: number;
  opening: string;
};

const EMPTY_SHOP: SetupInput['shop'] = {
  name: '',
  business_type: 'electronics',
  phone: '',
  address: '',
  city: '',
  ntn: '',
  strn: '',
};
const EMPTY_RECEIPT: SetupInput['receipt'] = {
  header: '',
  footer: DEFAULT_FOOTER,
  tax_rate_bp: 0,
  inclusive: false,
  round_total_to: 100,
};
const LANGS = [
  ['en', 'shell.lang_en'],
  ['ur', 'shell.lang_ur'],
  ['roman-ur', 'shell.lang_roman_ur'],
] as const;

/** Parses "17" / "17.5" / "۱۷" into basis points, or null when outside 0–25 or > 2 decimals. */
export function parseTaxPercent(text: string): number | null {
  const clean = normaliseNumericText(text).trim();
  if (clean === '') return 0;
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole = '0', frac = ''] = clean.split('.');
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return bp <= 2500 ? bp : null;
}

function Field({
  id,
  label,
  error,
  required = false,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  /** Shows a visible required mark (screens/01: name, phone and address are required). */
  required?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-small text-text">
        {label}
        {required ? (
          <span className="text-danger">
            <span aria-hidden="true"> *</span>
            <span className="sr-only"> ({t('common.required')})</span>
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-small text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SetupWizard() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const unlock = useSession((s) => s.unlock);
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;
  const cardRef = useRef<HTMLFormElement>(null);

  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState<Step>(0);
  const [shop, setShop] = useState(EMPTY_SHOP);
  const [ownerName, setOwnerName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [receipt, setReceipt] = useState(EMPTY_RECEIPT);
  const [taxText, setTaxText] = useState('0');
  const [logo, setLogo] = useState<ProcessedLogo | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [product, setProduct] = useState<ProductDraft | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const db = getDb();
    void (async () => {
      const draft = await loadSetupDraft(db);
      if (draft) {
        setStep(draft.step as Step);
        setShop(draft.shop);
        setOwnerName(draft.owner.name);
        setReceipt(draft.receipt);
        setTaxText(String(draft.receipt.tax_rate_bp / 100));
      } else {
        const tenant = await tenantInfo(db);
        if (tenant) setShop((s) => ({ ...s, name: tenant.display_name }));
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const draft: SetupDraft = {
      step,
      shop,
      owner: { name: ownerName },
      receipt,
    };
    void saveSetupDraft(getDb(), draft);
  }, [loaded, step, shop, ownerName, receipt]);

  const focusFirstError = (found: Errors) => {
    requestAnimationFrame(() => {
      const first = Object.keys(found)[0];
      if (first) document.getElementById(id(first))?.focus();
    });
  };

  const validate = (s: Step): Errors => {
    const e: Errors = {};
    if (s === 1) {
      const name = shop.name.trim();
      if (name.length < 2 || name.length > 60)
        e.shop_name = t('setup.errors.shop_name');
      if (!parsePkPhone(shop.phone, 'any')) e.phone = t('errors.phone_invalid');
      const address = shop.address.trim();
      if (address.length < 5 || address.length > 120)
        e.address = t('setup.errors.address');
      if (shop.city.trim().length > 40) e.city = t('setup.errors.too_long');
    }
    if (s === 2) {
      const name = ownerName.trim();
      if (name.length < 2 || name.length > 40)
        e.owner_name = t('setup.errors.owner_name');
      if (!/^\d{4}$/.test(pin) || isWeakPin(pin))
        e.pin = t('setup.errors.pin_weak');
      else if (pin2 !== pin) e.pin2 = t('setup.errors.pin_mismatch');
    }
    if (s === 3) {
      if (parseTaxPercent(taxText) === null) e.tax = t('setup.errors.tax');
      if (receipt.header.length > 120 || receipt.header.split('\n').length > 3)
        e.header = t('setup.errors.too_long');
      if (receipt.footer.length > 160 || receipt.footer.split('\n').length > 3)
        e.footer = t('setup.errors.too_long');
    }
    if (s === 4 && product && product.name.trim() === '')
      e.product_name = t('setup.errors.product_name');
    return e;
  };

  const goTo = (next: Step) => {
    setErrors({});
    // No header pre-fill: the receipt already prints the shop name and address above the
    // header, so pre-filling them printed the address twice (D-102).
    setStep(next);
  };

  const finish = async (
    withProduct: boolean,
    then: '/' | '/products/import' = '/',
  ) => {
    const found = withProduct ? validate(4) : {};
    setErrors(found);
    if (Object.keys(found).length > 0) return focusFirstError(found);
    setBusy(true);
    useSession.getState().setAfterSetup(then);
    try {
      const input: SetupInput = {
        shop,
        owner: { name: ownerName, pin },
        receipt,
        product:
          withProduct && product
            ? {
                name_en: product.name,
                sku: product.sku || generateSku(product.name),
                barcodes: product.barcode ? [product.barcode] : [],
                cost: product.cost,
                price: product.price,
                opening_milli: Math.round(
                  Number(normaliseNumericText(product.opening) || '0') * 1000,
                ),
              }
            : null,
      };
      const { owner } = await finishSetup(getDb(), input, { logo });
      unlock({ staff_id: owner.id, role: 'owner', unlocked_at: Date.now() });
      if (!navigator.onLine) toast.push(t('setup.saved_offline'));
      useSession.getState().setJustSetUp(true);
      await navigate({ to: then });
    } catch (error) {
      if (error instanceof SetupAlreadyDoneError) {
        toast.push(t('setup.already_done'));
        await navigate({ to: '/' });
        return;
      }
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (step === 0) return goTo(1);
    const found = validate(step);
    setErrors(found);
    if (Object.keys(found).length > 0) return focusFirstError(found);
    if (step === 4) return void finish(product !== null);
    goTo((step + 1) as Step);
  };
  const back = () => {
    if (step > 1) goTo((step - 1) as Step);
  };

  const keyRef = useRef({ next, back });
  keyRef.current = { next, back };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && /^Digit[123]$/.test(event.code)) {
        const lang = LANGS[Number(event.code.slice(-1)) - 1]?.[0];
        if (lang) {
          event.preventDefault();
          void setLanguage(lang);
        }
        return;
      }
      if (event.key === 'Escape') keyRef.current.back();
      // Enter = Next when focus is outside the form's fields (inside them the form submits itself).
      const target = event.target as HTMLElement | null;
      if (event.key === 'Enter' && (!target || target === document.body)) {
        event.preventDefault();
        keyRef.current.next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    next();
  };

  if (!loaded) return null;
  const language = isLocale(i18n.language) ? i18n.language : 'en';
  const err = (k: string) => errors[k];
  const described = (k: string) =>
    errors[k]
      ? { 'aria-invalid': true as const, 'aria-describedby': `${id(k)}-error` }
      : {};

  return (
    <div className="flex min-h-dvh items-start justify-center bg-bg px-3 py-6 text-text">
      <form
        ref={cardRef}
        noValidate
        onSubmit={onSubmit}
        className={`w-full ${step === 3 ? 'max-w-[960px]' : 'max-w-[560px]'} rounded-card border border-border bg-surface p-5`}
      >
        <header className="mb-4 flex items-center gap-3">
          <span className="text-h2 font-semibold">{t('common.app_name')}</span>
          {step > 0 ? (
            <span className="text-small text-text-muted" aria-live="polite">
              {t('setup.step_of', { n: step })}
              <span aria-hidden="true" className="ms-2">
                {[1, 2, 3, 4].map((n) => (n <= step ? '●' : '○')).join(' ')}
              </span>
            </span>
          ) : null}
          <label className="ms-auto">
            <span className="sr-only">{t('shell.language')}</span>
            <select
              className="h-11 rounded-control border border-border-strong bg-surface px-2"
              value={language}
              onChange={(e) => {
                if (isLocale(e.target.value)) void setLanguage(e.target.value);
              }}
            >
              {LANGS.map(([code, key]) => (
                <option key={code} value={code}>
                  {t(key)}
                </option>
              ))}
            </select>
          </label>
        </header>

        {step === 0 ? (
          <section className="flex flex-col gap-4">
            <h1 className="text-h1 font-semibold">{t('setup.welcome')}</h1>
            <p className="text-text-muted">{t('setup.welcome_hint')}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {LANGS.map(([code, key]) => (
                <button
                  key={code}
                  type="button"
                  aria-pressed={language === code}
                  className={`${buttonQuiet} min-h-16 text-h2 aria-pressed:border-primary aria-pressed:text-primary`}
                  onClick={() => void setLanguage(code)}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            <button type="submit" className={buttonPrimary}>
              {t('setup.start')}
            </button>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="flex flex-col gap-3">
            <h1 className="text-h1 font-semibold">{t('setup.shop_title')}</h1>
            <Field
              id={id('shop_name')}
              label={t('setup.shop_name')}
              error={err('shop_name')}
              required
            >
              <input
                id={id('shop_name')}
                className={fieldClass}
                value={shop.name}
                maxLength={60}
                required
                onChange={(e) => setShop({ ...shop, name: e.target.value })}
                {...described('shop_name')}
              />
            </Field>
            <fieldset>
              <legend className="mb-1 text-small">
                {t('setup.business_type')}
              </legend>
              <div className="flex flex-wrap gap-2">
                {BUSINESS_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={shop.business_type === type}
                    className="min-h-11 rounded-pill border border-border-strong px-3 aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-ink"
                    onClick={() =>
                      setShop({ ...shop, business_type: type as BusinessType })
                    }
                  >
                    {t(`setup.biz.${type}`)}
                  </button>
                ))}
              </div>
            </fieldset>
            <p className="text-small text-text-muted">
              {t('setup.currency')}: PKR (Rs)
            </p>
            <div>
              <PhoneInput
                id={id('phone')}
                label={t('setup.phone')}
                required
                kind="any"
                value={shop.phone}
                onChange={(e164) => setShop({ ...shop, phone: e164 ?? '' })}
              />
              {err('phone') ? (
                <p
                  id={`${id('phone')}-error`}
                  className="mt-1 text-small text-danger"
                >
                  {err('phone')}
                </p>
              ) : null}
            </div>
            <Field
              id={id('address')}
              label={t('setup.address')}
              error={err('address')}
              required
            >
              <textarea
                id={id('address')}
                rows={2}
                maxLength={120}
                className={`${fieldClass} h-auto py-2 font-sans`}
                value={shop.address}
                required
                onChange={(e) => setShop({ ...shop, address: e.target.value })}
                {...described('address')}
              />
            </Field>
            <Field id={id('city')} label={t('setup.city')} error={err('city')}>
              <input
                id={id('city')}
                className={fieldClass}
                maxLength={40}
                value={shop.city}
                onChange={(e) => setShop({ ...shop, city: e.target.value })}
              />
            </Field>
            <button
              type="button"
              aria-expanded={showMore}
              className="self-start text-small text-primary"
              onClick={() => setShowMore(!showMore)}
            >
              {t('setup.more')}
            </button>
            {showMore ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id={id('ntn')} label={t('setup.ntn')}>
                  <input
                    id={id('ntn')}
                    className={fieldClass}
                    value={shop.ntn}
                    onChange={(e) => setShop({ ...shop, ntn: e.target.value })}
                  />
                </Field>
                <Field id={id('strn')} label={t('setup.strn')}>
                  <input
                    id={id('strn')}
                    className={fieldClass}
                    value={shop.strn}
                    onChange={(e) => setShop({ ...shop, strn: e.target.value })}
                  />
                </Field>
              </div>
            ) : null}
          </section>
        ) : null}

        {step === 2 ? (
          <section className="flex flex-col gap-3">
            <h1 className="text-h1 font-semibold">{t('setup.owner_title')}</h1>
            <Field
              id={id('owner_name')}
              label={t('setup.owner_name')}
              error={err('owner_name')}
            >
              <input
                id={id('owner_name')}
                className={fieldClass}
                maxLength={40}
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                {...described('owner_name')}
              />
            </Field>
            <PinBoxes
              idPrefix={id('pin')}
              label={t('setup.pin')}
              value={pin}
              onChange={setPin}
              error={err('pin')}
            />
            <PinBoxes
              idPrefix={id('pin2')}
              label={t('setup.pin_confirm')}
              value={pin2}
              onChange={setPin2}
              error={err('pin2')}
            />
            <p className="text-small text-text-muted">{t('setup.pin_hint')}</p>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="grid gap-4 md:grid-cols-[1fr_340px]">
            <div className="flex flex-col gap-3">
              <h1 className="text-h1 font-semibold">
                {t('setup.receipt_title')}
              </h1>
              <div>
                <span className="mb-1 block text-small">{t('setup.logo')}</span>
                <div className="flex items-center gap-2">
                  <label className={buttonQuiet}>
                    {t('setup.logo_choose')}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/svg+xml"
                      className="sr-only"
                      data-testid="logo-input"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        try {
                          setLogo(await processLogo(file));
                          setErrors((x) => {
                            const { logo: _drop, ...rest } = x;
                            return rest;
                          });
                        } catch (error) {
                          if (!(error instanceof LogoError)) throw error;
                          setErrors((x) => ({
                            ...x,
                            logo: t('setup.errors.logo'),
                          }));
                        }
                      }}
                    />
                  </label>
                  {logo ? (
                    <button
                      type="button"
                      className="text-small text-primary"
                      onClick={() => setLogo(null)}
                    >
                      {t('setup.logo_remove')}
                    </button>
                  ) : null}
                </div>
                {err('logo') ? (
                  <p className="mt-1 text-small text-danger">{err('logo')}</p>
                ) : null}
              </div>
              <Field
                id={id('header')}
                label={t('setup.header')}
                error={err('header')}
              >
                <textarea
                  id={id('header')}
                  rows={3}
                  maxLength={120}
                  className={`${fieldClass} h-auto py-2 font-sans`}
                  value={receipt.header}
                  onChange={(e) =>
                    setReceipt({ ...receipt, header: e.target.value })
                  }
                />
              </Field>
              <Field
                id={id('footer')}
                label={t('setup.footer')}
                error={err('footer')}
              >
                <textarea
                  id={id('footer')}
                  rows={3}
                  maxLength={160}
                  className={`${fieldClass} h-auto py-2 font-sans`}
                  value={receipt.footer}
                  onChange={(e) =>
                    setReceipt({ ...receipt, footer: e.target.value })
                  }
                />
              </Field>
              <Field id={id('tax')} label={t('setup.tax')} error={err('tax')}>
                <input
                  id={id('tax')}
                  inputMode="decimal"
                  className={fieldClass}
                  value={taxText}
                  aria-describedby={`${id('tax')}-hint`}
                  onChange={(e) => {
                    setTaxText(e.target.value);
                    const bp = parseTaxPercent(e.target.value);
                    if (bp !== null)
                      setReceipt({
                        ...receipt,
                        tax_rate_bp: bp,
                        inclusive: bp > 0 && receipt.inclusive,
                      });
                  }}
                />
                <p
                  id={`${id('tax')}-hint`}
                  className="mt-1 text-small text-text-muted"
                >
                  {t('setup.tax_hint')}
                </p>
              </Field>
              {receipt.tax_rate_bp > 0 ? (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={receipt.inclusive}
                    className="mt-1 h-5 w-5"
                    checked={receipt.inclusive}
                    onChange={(e) =>
                      setReceipt({ ...receipt, inclusive: e.target.checked })
                    }
                  />
                  <span>
                    {t('setup.inclusive')}
                    <span className="block text-small text-text-muted">
                      {t('setup.inclusive_hint')}
                    </span>
                  </span>
                </label>
              ) : null}
              <Field id={id('round')} label={t('setup.round')}>
                <select
                  id={id('round')}
                  className={fieldClass}
                  value={receipt.round_total_to}
                  onChange={(e) =>
                    setReceipt({
                      ...receipt,
                      round_total_to: Number(
                        e.target.value,
                      ) as SetupInput['receipt']['round_total_to'],
                    })
                  }
                >
                  {ROUND_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      {v === 1
                        ? t('setup.round_none')
                        : t('setup.round_rs', { n: v / 100 })}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <ReceiptPreview
              logoUrl={logo?.previewUrl ?? null}
              shop={{
                ...shop,
                header: receipt.header,
                footer: receipt.footer,
                tax_rate_bp: receipt.tax_rate_bp,
                inclusive: receipt.inclusive,
              }}
            />
          </section>
        ) : null}

        {step === 4 ? (
          <section className="flex flex-col gap-3">
            <h1 className="text-h1 font-semibold">
              {t('setup.products_title')}
            </h1>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                aria-pressed={product !== null}
                className={`${buttonQuiet} min-h-16 aria-pressed:border-primary`}
                onClick={() =>
                  setProduct(
                    product ?? {
                      name: '',
                      sku: '',
                      barcode: '',
                      cost: 0,
                      price: 0,
                      opening: '',
                    },
                  )
                }
              >
                {t('setup.add_one')}
              </button>
              <button
                type="button"
                className={`${buttonQuiet} min-h-16 flex-col`}
                disabled={busy}
                onClick={() => void finish(false, '/products/import')}
              >
                {t('setup.import')}
                <span className="text-small text-text-muted">
                  {t('setup.import_hint')}
                </span>
              </button>
            </div>
            {product ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field
                    id={id('product_name')}
                    label={t('setup.product_name')}
                    error={err('product_name')}
                  >
                    <input
                      id={id('product_name')}
                      className={fieldClass}
                      maxLength={80}
                      value={product.name}
                      onChange={(e) =>
                        setProduct({ ...product, name: e.target.value })
                      }
                      {...described('product_name')}
                    />
                  </Field>
                </div>
                <Field id={id('barcode')} label={t('setup.barcode')}>
                  <input
                    id={id('barcode')}
                    className={fieldClass}
                    value={product.barcode}
                    onChange={(e) =>
                      setProduct({ ...product, barcode: e.target.value })
                    }
                  />
                </Field>
                <Field id={id('sku')} label={t('setup.sku')}>
                  <div className="flex gap-2">
                    <input
                      id={id('sku')}
                      className={fieldClass}
                      value={product.sku}
                      onChange={(e) =>
                        setProduct({ ...product, sku: e.target.value })
                      }
                    />
                    <button
                      type="button"
                      className={buttonQuiet}
                      onClick={() =>
                        setProduct({
                          ...product,
                          sku: generateSku(product.name),
                        })
                      }
                    >
                      {t('setup.generate')}
                    </button>
                  </div>
                </Field>
                <MoneyInput
                  label={t('setup.cost')}
                  value={product.cost}
                  onChange={(v) => setProduct({ ...product, cost: v ?? 0 })}
                />
                <MoneyInput
                  label={t('setup.price')}
                  value={product.price}
                  onChange={(v) => setProduct({ ...product, price: v ?? 0 })}
                />
                <Field id={id('opening')} label={t('setup.opening_stock')}>
                  <input
                    id={id('opening')}
                    inputMode="decimal"
                    className={fieldClass}
                    value={product.opening}
                    onChange={(e) =>
                      setProduct({ ...product, opening: e.target.value })
                    }
                  />
                </Field>
              </div>
            ) : null}
          </section>
        ) : null}

        {step > 0 ? (
          <footer className="mt-5 flex items-center gap-2">
            {step > 1 ? (
              <button type="button" className={buttonQuiet} onClick={back}>
                {t('setup.back')}
              </button>
            ) : null}
            {step === 4 ? (
              <button
                type="button"
                className="ms-auto min-h-11 px-3 text-primary"
                disabled={busy}
                onClick={() => void finish(false)}
              >
                {t('setup.skip')}
              </button>
            ) : null}
            <button
              type="submit"
              className={`${buttonPrimary} ${step === 4 ? '' : 'ms-auto'}`}
              disabled={busy}
            >
              {step === 4 ? t('setup.finish') : t('setup.next')}
            </button>
          </footer>
        ) : null}
      </form>
    </div>
  );
}
