import {
  generateSku,
  isWeakPin,
  normaliseNumericText,
  parsePkPhone,
} from '@bikri/core';
import {
  Box,
  Button,
  Checkbox,
  Group,
  NativeSelect,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SalesIcon } from '../components/icons.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
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
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        /^Digit[123]$/.test(event.code)
      ) {
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

  return (
    <Box
      mih="100dvh"
      bg="var(--mantine-color-body)"
      px="sm"
      py="lg"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
      }}
    >
      <Paper
        withBorder
        shadow="sm"
        p="lg"
        w="100%"
        style={{ maxWidth: step === 3 ? 960 : 560 }}
      >
        <form ref={cardRef} noValidate onSubmit={onSubmit}>
          <Group gap="sm" mb="md" wrap="nowrap">
            <ThemeIcon size={36} radius="md" color="accent" variant="filled">
              <SalesIcon />
            </ThemeIcon>
            <Text size="lg" fw={700}>
              {t('common.app_name')}
            </Text>
            {step > 0 ? (
              <Text size="sm" c="dimmed" aria-live="polite">
                {t('setup.step_of', { n: step })}
              </Text>
            ) : null}
            {step > 0 ? (
              <Box ms="auto">
                <LanguageSelect />
              </Box>
            ) : null}
          </Group>

          {step > 0 ? (
            <Progress
              value={(step / 4) * 100}
              size="sm"
              radius="xl"
              mb="md"
              aria-label={t('setup.step_of', { n: step })}
            />
          ) : null}

          {step === 0 ? (
            <Stack gap="md">
              <Title order={1}>{t('setup.welcome')}</Title>
              <Text c="dimmed">{t('setup.welcome_hint')}</Text>
              <Text size="sm" c="dimmed">
                {t('setup.offline_hint')}
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
                {LANGS.map(([code, key]) => (
                  <Button
                    key={code}
                    type="button"
                    h={64}
                    variant={language === code ? 'filled' : 'default'}
                    aria-pressed={language === code}
                    onClick={() => void setLanguage(code)}
                  >
                    {t(key)}
                  </Button>
                ))}
              </SimpleGrid>
              <Button type="submit" size="lg">
                {t('setup.start')}
              </Button>
            </Stack>
          ) : null}

          {step === 1 ? (
            <Stack gap="sm">
              <Title order={1}>{t('setup.shop_title')}</Title>
              <TextInput
                id={id('shop_name')}
                label={
                  <>
                    {t('setup.shop_name')}
                    <span className="sr-only"> ({t('common.required')})</span>
                  </>
                }
                required
                value={shop.name}
                maxLength={60}
                error={err('shop_name')}
                onChange={(event) =>
                  setShop({ ...shop, name: event.currentTarget.value })
                }
              />
              <Box
                component="fieldset"
                style={{ border: 0, margin: 0, padding: 0 }}
              >
                <Text component="legend" size="sm" mb={4}>
                  {t('setup.business_type')}
                </Text>
                <Group gap="xs">
                  {BUSINESS_TYPES.map((type) => (
                    <Button
                      key={type}
                      type="button"
                      size="compact-sm"
                      radius="xl"
                      variant={
                        shop.business_type === type ? 'filled' : 'default'
                      }
                      aria-pressed={shop.business_type === type}
                      onClick={() =>
                        setShop({
                          ...shop,
                          business_type: type as BusinessType,
                        })
                      }
                    >
                      {t(`setup.biz.${type}`)}
                    </Button>
                  ))}
                </Group>
              </Box>
              <Text size="sm" c="dimmed">
                {t('setup.currency')}: PKR (Rs)
              </Text>
              <PhoneInput
                id={id('phone')}
                label={`${t('setup.phone')} (${t('common.required')})`}
                required
                kind="any"
                value={shop.phone}
                onChange={(e164) => setShop({ ...shop, phone: e164 ?? '' })}
              />
              {err('phone') ? (
                <Text id={`${id('phone')}-error`} size="sm" c="danger">
                  {err('phone')}
                </Text>
              ) : null}
              <Textarea
                id={id('address')}
                label={
                  <>
                    {t('setup.address')}
                    <span className="sr-only"> ({t('common.required')})</span>
                  </>
                }
                required
                minRows={2}
                maxLength={120}
                value={shop.address}
                error={err('address')}
                onChange={(event) =>
                  setShop({ ...shop, address: event.currentTarget.value })
                }
              />
              <TextInput
                id={id('city')}
                label={t('setup.city')}
                maxLength={40}
                value={shop.city}
                error={err('city')}
                onChange={(event) =>
                  setShop({ ...shop, city: event.currentTarget.value })
                }
              />
              <Button
                type="button"
                variant="transparent"
                size="compact-sm"
                px={0}
                aria-expanded={showMore}
                onClick={() => setShowMore(!showMore)}
                style={{ alignSelf: 'flex-start' }}
              >
                {t('setup.more')}
              </Button>
              {showMore ? (
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  <TextInput
                    id={id('ntn')}
                    label={t('setup.ntn')}
                    value={shop.ntn}
                    onChange={(event) =>
                      setShop({ ...shop, ntn: event.currentTarget.value })
                    }
                  />
                  <TextInput
                    id={id('strn')}
                    label={t('setup.strn')}
                    value={shop.strn}
                    onChange={(event) =>
                      setShop({ ...shop, strn: event.currentTarget.value })
                    }
                  />
                </SimpleGrid>
              ) : null}
            </Stack>
          ) : null}

          {step === 2 ? (
            <Stack gap="sm">
              <Title order={1}>{t('setup.owner_title')}</Title>
              <TextInput
                id={id('owner_name')}
                label={t('setup.owner_name')}
                maxLength={40}
                value={ownerName}
                error={err('owner_name')}
                onChange={(event) => setOwnerName(event.currentTarget.value)}
              />
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
              <Text size="sm" c="dimmed">
                {t('setup.pin_hint')}
              </Text>
            </Stack>
          ) : null}

          {step === 3 ? (
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              <Stack gap="sm">
                <Title order={1}>{t('setup.receipt_title')}</Title>
                <Box
                  component="fieldset"
                  style={{ border: 0, margin: 0, padding: 0 }}
                >
                  <Text component="legend" size="sm" mb={4}>
                    {t('setup.logo')}
                  </Text>
                  <Group gap="sm">
                    <Button component="label" variant="default">
                      {t('setup.logo_choose')}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml"
                        className="sr-only"
                        data-testid="logo-input"
                        onChange={async (event) => {
                          const file = event.target.files?.[0];
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
                    </Button>
                    {logo ? (
                      <Button
                        type="button"
                        variant="transparent"
                        size="compact-sm"
                        px={0}
                        onClick={() => setLogo(null)}
                      >
                        {t('setup.logo_remove')}
                      </Button>
                    ) : null}
                  </Group>
                  {err('logo') ? (
                    <Text size="sm" c="danger" mt={4}>
                      {err('logo')}
                    </Text>
                  ) : null}
                </Box>
                <Textarea
                  id={id('header')}
                  label={t('setup.header')}
                  minRows={3}
                  maxLength={120}
                  value={receipt.header}
                  error={err('header')}
                  onChange={(event) =>
                    setReceipt({
                      ...receipt,
                      header: event.currentTarget.value,
                    })
                  }
                />
                <Textarea
                  id={id('footer')}
                  label={t('setup.footer')}
                  minRows={3}
                  maxLength={160}
                  value={receipt.footer}
                  error={err('footer')}
                  onChange={(event) =>
                    setReceipt({
                      ...receipt,
                      footer: event.currentTarget.value,
                    })
                  }
                />
                <TextInput
                  id={id('tax')}
                  label={t('setup.tax')}
                  description={t('setup.tax_hint')}
                  inputMode="decimal"
                  value={taxText}
                  error={err('tax')}
                  aria-describedby={`${id('tax')}-hint`}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    setTaxText(next);
                    const bp = parseTaxPercent(next);
                    if (bp !== null)
                      setReceipt({
                        ...receipt,
                        tax_rate_bp: bp,
                        inclusive: bp > 0 && receipt.inclusive,
                      });
                  }}
                />
                {receipt.tax_rate_bp > 0 ? (
                  <Checkbox
                    label={t('setup.inclusive')}
                    description={t('setup.inclusive_hint')}
                    checked={receipt.inclusive}
                    onChange={(event) =>
                      setReceipt({
                        ...receipt,
                        inclusive: event.currentTarget.checked,
                      })
                    }
                  />
                ) : null}
                <NativeSelect
                  id={id('round')}
                  label={t('setup.round')}
                  value={receipt.round_total_to}
                  onChange={(event) =>
                    setReceipt({
                      ...receipt,
                      round_total_to: Number(
                        event.currentTarget.value,
                      ) as SetupInput['receipt']['round_total_to'],
                    })
                  }
                  data={ROUND_OPTIONS.map((v) => ({
                    value: String(v),
                    label:
                      v === 1
                        ? t('setup.round_none')
                        : t('setup.round_rs', { n: v / 100 }),
                  }))}
                />
              </Stack>
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
            </SimpleGrid>
          ) : null}

          {step === 4 ? (
            <Stack gap="sm">
              <Title order={1}>{t('setup.products_title')}</Title>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <Button
                  type="button"
                  variant={product !== null ? 'light' : 'default'}
                  h={64}
                  aria-pressed={product !== null}
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
                </Button>
                <Button
                  type="button"
                  variant="default"
                  h={64}
                  disabled={busy}
                  onClick={() => void finish(false, '/products/import')}
                >
                  <Stack gap={0} align="center">
                    <Text size="sm">{t('setup.import')}</Text>
                    <Text size="xs" c="dimmed">
                      {t('setup.import_hint')}
                    </Text>
                  </Stack>
                </Button>
              </SimpleGrid>
              {product ? (
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  <Box style={{ gridColumn: '1 / -1' }}>
                    <TextInput
                      id={id('product_name')}
                      label={t('setup.product_name')}
                      maxLength={80}
                      value={product.name}
                      error={err('product_name')}
                      onChange={(event) =>
                        setProduct({
                          ...product,
                          name: event.currentTarget.value,
                        })
                      }
                    />
                  </Box>
                  <TextInput
                    id={id('barcode')}
                    label={t('setup.barcode')}
                    value={product.barcode}
                    onChange={(event) =>
                      setProduct({
                        ...product,
                        barcode: event.currentTarget.value,
                      })
                    }
                  />
                  <Group gap="xs" align="flex-end" wrap="nowrap">
                    <TextInput
                      id={id('sku')}
                      label={t('setup.sku')}
                      value={product.sku}
                      onChange={(event) =>
                        setProduct({
                          ...product,
                          sku: event.currentTarget.value,
                        })
                      }
                      style={{ flex: 1 }}
                    />
                    <Button
                      type="button"
                      variant="default"
                      onClick={() =>
                        setProduct({
                          ...product,
                          sku: generateSku(product.name),
                        })
                      }
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      {t('setup.generate')}
                    </Button>
                  </Group>
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
                  <TextInput
                    id={id('opening')}
                    label={t('setup.opening_stock')}
                    inputMode="decimal"
                    value={product.opening}
                    onChange={(event) =>
                      setProduct({
                        ...product,
                        opening: event.currentTarget.value,
                      })
                    }
                  />
                </SimpleGrid>
              ) : null}
            </Stack>
          ) : null}

          {step > 0 ? (
            <Group gap="sm" mt="lg">
              {step > 1 ? (
                <Button variant="default" onClick={back}>
                  {t('setup.back')}
                </Button>
              ) : null}
              {step === 4 ? (
                <Button
                  variant="subtle"
                  ms="auto"
                  disabled={busy}
                  onClick={() => void finish(false)}
                >
                  {t('setup.skip')}
                </Button>
              ) : null}
              <Button
                type="submit"
                disabled={busy}
                ms={step === 4 ? undefined : 'auto'}
              >
                {step === 4 ? t('setup.finish') : t('setup.next')}
              </Button>
            </Group>
          ) : null}
        </form>
      </Paper>
    </Box>
  );
}
