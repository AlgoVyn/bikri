import {
  Box,
  Button,
  Checkbox,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StoreIcon } from '../components/icons.tsx';
import { PageLoading } from '../components/PageLoading';
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

  if (!data) return <PageLoading compact />;

  return (
    <SettingsPageLayout title={t('office.settings.title')} icon={<StoreIcon />}>
      <Paper withBorder p="lg">
        <Stack gap="sm">
          <Title order={2} fz="lg">
            {t('setup.shop_title')}
          </Title>
          <TextInput
            label={t('setup.shop_name')}
            maxLength={60}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <Box
            component="fieldset"
            style={{ border: 0, margin: 0, padding: 0 }}
          >
            <Text component="legend" size="sm" mb={4}>
              {t('setup.business_type')}
            </Text>
            <NativeSelect
              hiddenFrom="sm"
              aria-label={t('setup.business_type')}
              value={form.business_type}
              onChange={(event) =>
                setForm({ ...form, business_type: event.target.value })
              }
              data={BUSINESS_TYPES.map((type) => ({
                value: type,
                label: t(`setup.biz.${type}`),
              }))}
            />
            <Group visibleFrom="sm" gap="xs">
              {BUSINESS_TYPES.map((type) => (
                <Button
                  key={type}
                  type="button"
                  variant={form.business_type === type ? 'filled' : 'default'}
                  aria-pressed={form.business_type === type}
                  onClick={() => setForm({ ...form, business_type: type })}
                >
                  {t(`setup.biz.${type}`)}
                </Button>
              ))}
            </Group>
          </Box>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label={t('setup.phone')}
              value={form.phone}
              onChange={(event) =>
                setForm({ ...form, phone: event.target.value })
              }
            />
            <TextInput
              label={t('setup.city')}
              maxLength={40}
              value={form.city}
              onChange={(event) =>
                setForm({ ...form, city: event.target.value })
              }
            />
          </SimpleGrid>
          <TextInput
            label={t('setup.address')}
            maxLength={120}
            value={form.address}
            onChange={(event) =>
              setForm({ ...form, address: event.target.value })
            }
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label={t('setup.ntn')}
              value={form.ntn}
              onChange={(event) =>
                setForm({ ...form, ntn: event.target.value })
              }
            />
            <TextInput
              label={t('setup.strn')}
              value={form.strn}
              onChange={(event) =>
                setForm({ ...form, strn: event.target.value })
              }
            />
          </SimpleGrid>
          <Group gap="sm">
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
            <Button
              type="button"
              variant="default"
              onClick={() => fileRef.current?.click()}
            >
              {t('setup.logo_choose')}
            </Button>
            {logo ? (
              <Button
                type="button"
                variant="default"
                disabled={readOnly}
                onClick={() => void saveLogo()}
              >
                {t('office.settings.save_logo')}
              </Button>
            ) : null}
            {logoUrl ? (
              <Button
                type="button"
                variant="default"
                onClick={() => void removeLogo()}
              >
                {t('setup.logo_remove')}
              </Button>
            ) : null}
            {logoUrl ? (
              <img
                src={logoUrl}
                alt={t('setup.logo_preview')}
                className="h-10"
              />
            ) : null}
          </Group>
          <Button
            type="button"
            disabled={saving || readOnly}
            loading={saving}
            onClick={() => void saveShop()}
            style={{ alignSelf: 'flex-start' }}
          >
            {t('office.settings.save')}
          </Button>
        </Stack>
      </Paper>

      <Paper withBorder p="lg">
        <Stack gap="sm">
          <Title order={2} fz="lg">
            {t('setup.receipt_title')}
          </Title>
          <Textarea
            label={t('setup.header')}
            maxLength={120}
            autosize
            minRows={2}
            value={form.receipt_header}
            onChange={(event) =>
              setForm({ ...form, receipt_header: event.target.value })
            }
          />
          <Textarea
            label={t('setup.footer')}
            maxLength={160}
            autosize
            minRows={2}
            value={form.receipt_footer}
            onChange={(event) =>
              setForm({ ...form, receipt_footer: event.target.value })
            }
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <NumberInput
              label={t('setup.tax')}
              min={0}
              max={50}
              step={0.01}
              decimalScale={2}
              value={form.tax_rate_bp / 100}
              onChange={(value) =>
                setForm({
                  ...form,
                  tax_rate_bp: Math.round(
                    Math.max(0, Math.min(50, Number(value) || 0)) * 100,
                  ),
                })
              }
            />
            <TextInput
              label={t('office.settings.tax_label')}
              maxLength={30}
              value={form.tax_label}
              onChange={(event) =>
                setForm({ ...form, tax_label: event.target.value })
              }
            />
            <NativeSelect
              label={t('office.settings.round_total')}
              value={form.round_total_to}
              onChange={(event) =>
                setForm({
                  ...form,
                  round_total_to: Number(event.currentTarget.value) as
                    | 1
                    | 100
                    | 500
                    | 1000,
                })
              }
              data={[
                { value: '1', label: t('setup.round_none') },
                { value: '100', label: t('setup.round_rs', { n: 1 }) },
                { value: '500', label: t('setup.round_rs', { n: 5 }) },
                { value: '1000', label: t('setup.round_rs', { n: 10 }) },
              ]}
            />
            <NativeSelect
              label={t('office.settings.refund_rounding')}
              value={form.refund_rounding}
              onChange={(event) =>
                setForm({
                  ...form,
                  refund_rounding: event.currentTarget.value as
                    | 'nearest'
                    | 'down'
                    | 'none',
                })
              }
              data={[
                {
                  value: 'nearest',
                  label: t('office.settings.round_nearest'),
                },
                { value: 'down', label: t('office.settings.round_down') },
                { value: 'none', label: t('office.settings.round_exact') },
              ]}
            />
            <NativeSelect
              label={t('office.settings.receipt_language')}
              value={form.receipt_language}
              onChange={(event) =>
                setForm({
                  ...form,
                  receipt_language: event.currentTarget.value as
                    | 'app'
                    | 'en'
                    | 'ur',
                })
              }
              data={[
                { value: 'app', label: t('office.settings.lang_app') },
                { value: 'en', label: t('office.settings.lang_en') },
                { value: 'ur', label: t('office.settings.lang_ur') },
              ]}
            />
            <NativeSelect
              label={t('office.settings.number_grouping')}
              value={form.number_grouping}
              onChange={(event) =>
                setForm({
                  ...form,
                  number_grouping: event.currentTarget.value as 'intl' | 'lakh',
                })
              }
              data={[
                {
                  value: 'intl',
                  label: t('office.settings.grouping_intl'),
                },
                {
                  value: 'lakh',
                  label: t('office.settings.grouping_lakh'),
                },
              ]}
            />
          </SimpleGrid>
          {form.tax_rate_bp > 0 ? (
            <Checkbox
              label={t('setup.inclusive')}
              checked={form.tax_mode === 'inclusive'}
              onChange={(event) =>
                setForm({
                  ...form,
                  tax_mode: event.currentTarget.checked
                    ? 'inclusive'
                    : 'exclusive',
                })
              }
            />
          ) : (
            <Text size="sm" c="dimmed">
              {t('office.settings.tax_off_hint')}
            </Text>
          )}
          <Text size="sm" c="dimmed">
            {t('office.settings.applies_new')}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            <Checkbox
              label={t('office.settings.show_cashier')}
              checked={form.show_cashier_on_receipt}
              onChange={(event) =>
                setForm({
                  ...form,
                  show_cashier_on_receipt: event.currentTarget.checked,
                })
              }
            />
            <Checkbox
              label={t('office.settings.show_payment_details')}
              checked={form.show_payment_details}
              onChange={(event) =>
                setForm({
                  ...form,
                  show_payment_details: event.currentTarget.checked,
                })
              }
            />
            <Checkbox
              label={t('office.settings.show_you_saved')}
              checked={form.show_you_saved}
              onChange={(event) =>
                setForm({
                  ...form,
                  show_you_saved: event.currentTarget.checked,
                })
              }
            />
            <Checkbox
              label={t('office.settings.print_warranty')}
              checked={form.print_warranty}
              onChange={(event) =>
                setForm({
                  ...form,
                  print_warranty: event.currentTarget.checked,
                })
              }
            />
          </SimpleGrid>
          <ReceiptPreview
            shop={preview}
            logoUrl={logoUrl}
            paperMm={data.printer?.paper_mm === 58 ? 58 : 80}
          />
          <Button
            type="button"
            disabled={saving || readOnly}
            loading={saving}
            onClick={() => void saveShop()}
            style={{ alignSelf: 'flex-start' }}
          >
            {t('office.settings.save')}
          </Button>
        </Stack>
      </Paper>

      {data.branch ? (
        <Paper withBorder p="lg">
          <Stack gap="sm">
            <Title order={2} fz="lg">
              {t('office.settings.branch')}
            </Title>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <TextInput
                label={t('office.settings.branch_name')}
                value={branch.name}
                onChange={(event) =>
                  setBranch({ ...branch, name: event.target.value })
                }
              />
              <TextInput
                label={t('office.settings.bill_prefix')}
                maxLength={6}
                value={branch.bill_prefix}
                onChange={(event) =>
                  setBranch({
                    ...branch,
                    bill_prefix: event.target.value.toUpperCase(),
                  })
                }
              />
              <TextInput
                label={t('setup.address')}
                value={branch.address}
                onChange={(event) =>
                  setBranch({ ...branch, address: event.target.value })
                }
              />
              <TextInput
                label={t('setup.phone')}
                value={branch.phone}
                onChange={(event) =>
                  setBranch({ ...branch, phone: event.target.value })
                }
              />
            </SimpleGrid>
            <Group gap="sm">
              <Button
                type="button"
                disabled={readOnly}
                onClick={() => void saveBranch()}
              >
                {t('office.settings.save')}
              </Button>
              <Button
                type="button"
                variant="default"
                disabled
                title={t('office.settings.add_branch_soon')}
              >
                {t('office.settings.add_branch')}
              </Button>
            </Group>
          </Stack>
        </Paper>
      ) : null}

      <Paper withBorder p="lg">
        <Stack gap="sm">
          <Title order={2} fz="lg">
            {t('office.settings.categories')}
          </Title>
          <Text size="sm" c="dimmed">
            {t('office.settings.categories_hint')}
          </Text>
          <Group gap="sm">
            <Button component={Link} to="/products" variant="default">
              {t('office.settings.open_products')}
            </Button>
            <Button component={Link} to="/expenses" variant="default">
              {t('office.settings.open_expenses')}
            </Button>
          </Group>
        </Stack>
      </Paper>
    </SettingsPageLayout>
  );
}
