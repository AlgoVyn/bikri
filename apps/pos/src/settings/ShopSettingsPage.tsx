import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { StoreIcon } from '../components/icons.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { getKv } from '../data/kv.ts';
import { defaultBranch } from '../data/localTenant.ts';
import {
  type BranchSettings,
  BUSINESS_TYPES,
  SettingsError,
  type ShopSettings,
  shopSettings,
  updateBranchSettings,
  updateShopLogo,
  updateShopSettings,
} from '../data/settings.ts';
import type { LogoData } from '../data/setup.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { ditheredPreview, LogoError, processLogo } from '../setup/logo.ts';
import { ReceiptPreview } from '../setup/ReceiptPreview.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { SettingsGuard } from './Guard.tsx';
import { SettingsPageLayout } from './Layout.tsx';

const field =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';
const area =
  'min-h-20 w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-text';

/** Shop profile, receipt/tax and the single v1 branch (screens/17). */
export function ShopSettingsPage() {
  return (
    <AreaStrings area="office">
      <SettingsGuard permission="settings.shop">
        <ShopForm />
      </SettingsGuard>
    </AreaStrings>
  );
}

function ShopForm() {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff } = useCurrentStaff();
  const readOnly = useReadOnly();
  const data = useLiveQuery(async () => {
    const db = getDb();
    return {
      shop: await db.shop.get('shop'),
      branch: await defaultBranch(db),
      logo: await getKv<LogoData | null>(db, 'logo_bitmap', null),
      printer: await getKv<{ paper_mm?: number } | null>(db, 'printer', null),
    };
  }, []);
  const [form, setForm] = useState<ShopSettings>(() => shopSettings(undefined));
  const [branch, setBranch] = useState<BranchSettings>({
    name: '',
    bill_prefix: '',
    address: '',
    phone: '',
  });
  const [logo, setLogo] = useState<LogoData | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (!data?.shop || loaded.current) return;
    loaded.current = true;
    setForm(shopSettings(data.shop));
    if (data.branch)
      setBranch({
        name: String(data.branch.name ?? ''),
        bill_prefix: String(data.branch.bill_prefix ?? ''),
        address: String(data.branch.address ?? ''),
        phone: String(data.branch.phone ?? ''),
      });
    if (data.logo) setLogo(data.logo);
  }, [data]);

  useEffect(() => {
    if (!logo) {
      setLogoUrl(null);
      return;
    }
    try {
      setLogoUrl(ditheredPreview(logo.bitmap));
    } catch {
      setLogoUrl(null);
    }
  }, [logo]);

  const preview = useMemo(
    () => ({
      name: form.name,
      address: form.address,
      phone: form.phone,
      header: form.receipt_header,
      footer: form.receipt_footer,
      tax_rate_bp: form.tax_rate_bp,
      inclusive: form.tax_mode === 'inclusive',
      tax_label: form.tax_label,
      receipt_language: form.receipt_language,
    }),
    [form],
  );

  const saveShop = async () => {
    setSaving(true);
    try {
      await updateShopSettings(getDb(), form, staff?.id ?? null);
      toast.push(t('office.settings.saved'));
    } catch (err) {
      toast.push(
        err instanceof SettingsError
          ? t(`office.settings.error_${err.code}`)
          : t('errors.generic'),
        'error',
      );
    } finally {
      setSaving(false);
    }
  };
  const saveBranch = async () => {
    if (!data?.branch) return;
    try {
      await updateBranchSettings(
        getDb(),
        String(data.branch.id),
        branch,
        staff?.id ?? null,
      );
      toast.push(t('office.settings.branch_saved'));
    } catch (err) {
      toast.push(
        err instanceof SettingsError
          ? t(`office.settings.error_${err.code}`)
          : t('errors.generic'),
        'error',
      );
    }
  };
  const chooseLogo = async (file: File) => {
    try {
      const processed = await processLogo(file);
      setLogo({
        png: processed.png,
        sha256: processed.sha256,
        bitmap: processed.bitmap,
      });
    } catch (err) {
      toast.push(
        err instanceof LogoError ? t('setup.errors.logo') : t('errors.generic'),
        'error',
      );
    }
  };
  const saveLogo = async () => {
    try {
      await updateShopLogo(getDb(), logo, staff?.id ?? null);
      toast.push(t('office.settings.saved'));
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };
  const removeLogo = async () => {
    await updateShopLogo(getDb(), null, staff?.id ?? null);
    setLogo(null);
    toast.push(t('office.settings.saved'));
  };

  if (!data) return <p className="sr-only">{t('common.loading')}</p>;

  return (
    <SettingsPageLayout title={t('office.settings.title')} icon={<StoreIcon />}>
      <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
        <h2 className="text-title font-semibold">{t('setup.shop_title')}</h2>
        <label className="flex flex-col gap-1 text-small">
          {t('setup.shop_name')}
          <input
            className={field}
            maxLength={60}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <fieldset>
          <legend className="mb-1 text-small">
            {t('setup.business_type')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {BUSINESS_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={form.business_type === type}
                className={`${buttonQuiet} px-3 aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-ink`}
                onClick={() => setForm({ ...form, business_type: type })}
              >
                {t(`setup.biz.${type}`)}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-small">
            {t('setup.phone')}
            <input
              className={field}
              value={form.phone}
              onChange={(event) =>
                setForm({ ...form, phone: event.target.value })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-small">
            {t('setup.city')}
            <input
              className={field}
              maxLength={40}
              value={form.city}
              onChange={(event) =>
                setForm({ ...form, city: event.target.value })
              }
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-small">
          {t('setup.address')}
          <input
            className={field}
            maxLength={120}
            value={form.address}
            onChange={(event) =>
              setForm({ ...form, address: event.target.value })
            }
          />
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-small">
            {t('setup.ntn')}
            <input
              className={field}
              value={form.ntn}
              onChange={(event) =>
                setForm({ ...form, ntn: event.target.value })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-small">
            {t('setup.strn')}
            <input
              className={field}
              value={form.strn}
              onChange={(event) =>
                setForm({ ...form, strn: event.target.value })
              }
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            aria-label={t('office.settings.logo')}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void chooseLogo(file);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => fileRef.current?.click()}
          >
            {t('setup.logo_choose')}
          </button>
          {logo ? (
            <button
              type="button"
              className={buttonQuiet}
              disabled={readOnly}
              onClick={() => void saveLogo()}
            >
              {t('office.settings.save_logo')}
            </button>
          ) : null}
          {logoUrl ? (
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => void removeLogo()}
            >
              {t('setup.logo_remove')}
            </button>
          ) : null}
          {logoUrl ? (
            <img src={logoUrl} alt={t('setup.logo_preview')} className="h-10" />
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
        <h2 className="text-title font-semibold">{t('setup.receipt_title')}</h2>
        <label className="flex flex-col gap-1 text-small">
          {t('setup.header')}
          <textarea
            className={area}
            maxLength={120}
            value={form.receipt_header}
            onChange={(event) =>
              setForm({ ...form, receipt_header: event.target.value })
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-small">
          {t('setup.footer')}
          <textarea
            className={area}
            maxLength={160}
            value={form.receipt_footer}
            onChange={(event) =>
              setForm({ ...form, receipt_footer: event.target.value })
            }
          />
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-small">
            {t('setup.tax')}
            <input
              type="number"
              min={0}
              max={50}
              step={0.01}
              className={field}
              value={form.tax_rate_bp / 100}
              onChange={(event) =>
                setForm({
                  ...form,
                  tax_rate_bp: Math.round(
                    Math.max(0, Math.min(50, Number(event.target.value) || 0)) *
                      100,
                  ),
                })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-small">
            {t('office.settings.tax_label')}
            <input
              className={field}
              maxLength={30}
              value={form.tax_label}
              onChange={(event) =>
                setForm({ ...form, tax_label: event.target.value })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-small">
            {t('office.settings.round_total')}
            <select
              className={field}
              value={form.round_total_to}
              onChange={(event) =>
                setForm({
                  ...form,
                  round_total_to: Number(event.target.value) as
                    | 1
                    | 100
                    | 500
                    | 1000,
                })
              }
            >
              <option value={1}>{t('setup.round_none')}</option>
              <option value={100}>{t('setup.round_rs', { n: 1 })}</option>
              <option value={500}>{t('setup.round_rs', { n: 5 })}</option>
              <option value={1000}>{t('setup.round_rs', { n: 10 })}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-small">
            {t('office.settings.refund_rounding')}
            <select
              className={field}
              value={form.refund_rounding}
              onChange={(event) =>
                setForm({
                  ...form,
                  refund_rounding: event.target.value as
                    | 'nearest'
                    | 'down'
                    | 'none',
                })
              }
            >
              <option value="nearest">
                {t('office.settings.round_nearest')}
              </option>
              <option value="down">{t('office.settings.round_down')}</option>
              <option value="none">{t('office.settings.round_exact')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-small">
            {t('office.settings.receipt_language')}
            <select
              className={field}
              value={form.receipt_language}
              onChange={(event) =>
                setForm({
                  ...form,
                  receipt_language: event.target.value as 'app' | 'en' | 'ur',
                })
              }
            >
              <option value="app">{t('office.settings.lang_app')}</option>
              <option value="en">{t('office.settings.lang_en')}</option>
              <option value="ur">{t('office.settings.lang_ur')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-small">
            {t('office.settings.number_grouping')}
            <select
              className={field}
              value={form.number_grouping}
              onChange={(event) =>
                setForm({
                  ...form,
                  number_grouping: event.target.value as 'intl' | 'lakh',
                })
              }
            >
              <option value="intl">{t('office.settings.grouping_intl')}</option>
              <option value="lakh">{t('office.settings.grouping_lakh')}</option>
            </select>
          </label>
        </div>
        {form.tax_rate_bp > 0 ? (
          <label className="flex items-center gap-2 text-small">
            <input
              type="checkbox"
              checked={form.tax_mode === 'inclusive'}
              onChange={(event) =>
                setForm({
                  ...form,
                  tax_mode: event.target.checked ? 'inclusive' : 'exclusive',
                })
              }
            />
            {t('setup.inclusive')}
          </label>
        ) : (
          <p className="text-small text-text-muted">
            {t('office.settings.tax_off_hint')}
          </p>
        )}
        <p className="text-small text-text-muted">
          {t('office.settings.applies_new')}
        </p>
        <div className="grid gap-1 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-small">
            <input
              type="checkbox"
              checked={form.show_cashier_on_receipt}
              onChange={(event) =>
                setForm({
                  ...form,
                  show_cashier_on_receipt: event.target.checked,
                })
              }
            />
            {t('office.settings.show_cashier')}
          </label>
          <label className="flex items-center gap-2 text-small">
            <input
              type="checkbox"
              checked={form.show_payment_details}
              onChange={(event) =>
                setForm({ ...form, show_payment_details: event.target.checked })
              }
            />
            {t('office.settings.show_payment_details')}
          </label>
          <label className="flex items-center gap-2 text-small">
            <input
              type="checkbox"
              checked={form.show_you_saved}
              onChange={(event) =>
                setForm({ ...form, show_you_saved: event.target.checked })
              }
            />
            {t('office.settings.show_you_saved')}
          </label>
          <label className="flex items-center gap-2 text-small">
            <input
              type="checkbox"
              checked={form.print_warranty}
              onChange={(event) =>
                setForm({ ...form, print_warranty: event.target.checked })
              }
            />
            {t('office.settings.print_warranty')}
          </label>
        </div>
        <ReceiptPreview
          shop={preview}
          logoUrl={logoUrl}
          paperMm={data?.printer?.paper_mm === 58 ? 58 : 80}
        />
        <button
          type="button"
          className={`${buttonPrimary} self-start`}
          disabled={saving || readOnly}
          onClick={() => void saveShop()}
        >
          {t('office.settings.save')}
        </button>
      </section>

      {data.branch ? (
        <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
          <h2 className="text-title font-semibold">
            {t('office.settings.branch')}
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-small">
              {t('office.settings.branch_name')}
              <input
                className={field}
                value={branch.name}
                onChange={(event) =>
                  setBranch({ ...branch, name: event.target.value })
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-small">
              {t('office.settings.bill_prefix')}
              <input
                className={field}
                maxLength={6}
                value={branch.bill_prefix}
                onChange={(event) =>
                  setBranch({
                    ...branch,
                    bill_prefix: event.target.value.toUpperCase(),
                  })
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-small">
              {t('setup.address')}
              <input
                className={field}
                value={branch.address}
                onChange={(event) =>
                  setBranch({ ...branch, address: event.target.value })
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-small">
              {t('setup.phone')}
              <input
                className={field}
                value={branch.phone}
                onChange={(event) =>
                  setBranch({ ...branch, phone: event.target.value })
                }
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonPrimary}
              disabled={readOnly}
              onClick={() => void saveBranch()}
            >
              {t('office.settings.save')}
            </button>
            <button
              type="button"
              className={buttonQuiet}
              disabled
              title={t('office.settings.add_branch_soon')}
            >
              {t('office.settings.add_branch')}
            </button>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
        <h2 className="text-title font-semibold">
          {t('office.settings.categories')}
        </h2>
        <p className="text-small text-text-muted">
          {t('office.settings.categories_hint')}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to="/products" className={buttonQuiet}>
            {t('office.settings.open_products')}
          </Link>
          <Link to="/expenses" className={buttonQuiet}>
            {t('office.settings.open_expenses')}
          </Link>
        </div>
      </section>
    </SettingsPageLayout>
  );
}
