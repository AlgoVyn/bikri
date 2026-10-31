import { normaliseNumericText, parseMoneyToPaisa } from '@bikri/core';
import {
  Box,
  Button,
  Group,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { Navigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ProductsIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  applyPrices,
  type PriceChange,
  type PricePreviewRow,
  pricePreview,
  ROUNDINGS,
  type Rounding,
} from '../data/bulkPrice.ts';
import { ledgerContext, listCategories } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

const PREVIEW_LIMIT = 200;
type Kind = PriceChange['kind'];

/** `10`, `-5`, `2.5` → basis points; null when not a number. */
export function percentToBp(raw: string): number | null {
  const text = normaliseNumericText(raw)
    .trim()
    .replace('\u2212', '-')
    .replace('%', '');
  if (!/^-?\d+(?:\.\d{1,2})?$/u.test(text)) return null;
  return Math.round(Number(text) * 100);
}

function changeOf(kind: Kind, raw: string): PriceChange | null {
  if (kind === 'percent') {
    const bp = percentToBp(raw);
    return bp === null || bp <= -10_000 ? null : { kind, bp };
  }
  const paisa = parseMoneyToPaisa(raw.replace('\u2212', '-'), {
    allowNegative: kind === 'amount',
  });
  return paisa === null ? null : { kind, paisa };
}

/** Update prices (bulk), screens/08: filter → change → rounding → preview → apply. */
export function PricesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const id = useId();
  const categories = useLiveQuery(() => listCategories(getDb()), []) ?? [];
  const [categoryId, setCategoryId] = useState('');
  const [brand, setBrand] = useState('');
  const [kind, setKind] = useState<Kind>('percent');
  const [value, setValue] = useState('');
  const [rounding, setRounding] = useState<Rounding>(0);
  const [rows, setRows] = useState<PricePreviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can('catalog.edit')) return <Navigate to="/products" replace />;

  const reset = () => setRows(null);
  const preview = async () => {
    const change = changeOf(kind, value);
    if (!change) {
      setError(t('prices.value_invalid'));
      return;
    }
    setError(null);
    setRows(
      await pricePreview(
        getDb(),
        { categoryId: categoryId || null, brand },
        change,
        rounding,
      ),
    );
  };
  const changed = rows?.filter((r) => r.next !== r.old) ?? [];
  const apply = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const ctx = await ledgerContext(getDb(), staff?.id ?? '');
      const n = await applyPrices(getDb(), rows, ctx);
      toast.push(t('prices.applied', { count: n }), 'info');
      setRows(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box mx="auto" maw={896} p="md" w="100%">
      <Stack gap="md">
        <SubpageHeader
          backTo="/products"
          backLabel={t('import.back_to_products')}
          icon={<ProductsIcon />}
          title={t('prices.title')}
        />
        <Paper withBorder p="lg">
          <Stack gap="sm">
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <NativeSelect
                id={`${id}-cat`}
                label={t('products.category_filter')}
                value={categoryId}
                onChange={(event) => {
                  setCategoryId(event.currentTarget.value);
                  reset();
                }}
                data={[
                  { value: '', label: t('products.all_categories') },
                  ...categories.map((c) => ({
                    value: c.id,
                    label: String(c.name_en),
                  })),
                ]}
              />
              <TextInput
                id={`${id}-brand`}
                label={t('prices.brand')}
                value={brand}
                placeholder={t('prices.any_brand')}
                onChange={(event) => {
                  setBrand(event.currentTarget.value);
                  reset();
                }}
              />
              <NativeSelect
                id={`${id}-kind`}
                label={t('prices.change')}
                value={kind}
                onChange={(event) => {
                  setKind(event.currentTarget.value as Kind);
                  reset();
                }}
                data={[
                  { value: 'percent', label: t('prices.kind_percent') },
                  { value: 'amount', label: t('prices.kind_amount') },
                  { value: 'set', label: t('prices.kind_set') },
                ]}
              />
              <TextInput
                id={`${id}-value`}
                label={
                  kind === 'percent'
                    ? t('prices.value_percent')
                    : t('prices.value_rs')
                }
                inputMode="decimal"
                dir="ltr"
                value={value}
                error={error ?? undefined}
                onChange={(event) => {
                  setValue(event.currentTarget.value);
                  reset();
                }}
              />
              <NativeSelect
                id={`${id}-round`}
                label={t('prices.rounding')}
                value={String(rounding)}
                onChange={(event) => {
                  setRounding(Number(event.currentTarget.value) as Rounding);
                  reset();
                }}
                data={ROUNDINGS.map((r) => ({
                  value: String(r),
                  label:
                    r === 0
                      ? t('prices.round_none')
                      : t('prices.round_rs', { n: r / 100 }),
                }))}
              />
            </SimpleGrid>
            {error ? (
              <Text c="danger" role="alert" size="sm">
                {error}
              </Text>
            ) : null}
            <Group justify="flex-end">
              <Button
                type="button"
                variant="default"
                onClick={() => void preview()}
              >
                {t('prices.preview')}
              </Button>
            </Group>
          </Stack>
        </Paper>

        {rows ? (
          <Paper withBorder p="lg">
            <Stack gap="sm">
              <Text role="status" size="sm" data-testid="prices-summary">
                {t('prices.summary', {
                  count: changed.length,
                  total: rows.length,
                })}
              </Text>
              <Box
                tabIndex={0}
                role="region"
                aria-label={t('prices.title')}
                style={{ overflowX: 'auto' }}
              >
                <Table fz="sm" miw={480}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('import.field.name_en')}</Table.Th>
                      <Table.Th ta="end">{t('prices.old')}</Table.Th>
                      <Table.Th ta="end">{t('prices.new')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {rows.slice(0, PREVIEW_LIMIT).map((r) => (
                      <Table.Tr key={r.product.id} data-testid="price-row">
                        <Table.Td>{String(r.product.name_en)}</Table.Td>
                        <Table.Td ta="end">
                          <MoneyText paisa={r.old} />
                        </Table.Td>
                        <Table.Td ta="end">
                          <Text
                            size="sm"
                            fw={r.next !== r.old ? 600 : undefined}
                          >
                            <MoneyText paisa={r.next} />
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Box>
              <Group justify="flex-end">
                <Button
                  type="button"
                  disabled={busy || changed.length === 0}
                  loading={busy}
                  onClick={() => void apply()}
                >
                  {t('prices.apply', { count: changed.length })}
                </Button>
              </Group>
            </Stack>
          </Paper>
        ) : null}
      </Stack>
    </Box>
  );
}
