import { formatQtyFromMilli, type QtyUnit } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import {
  Box,
  Button,
  Checkbox,
  Group,
  NativeSelect,
  Paper,
  Radio,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { Navigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ProductsIcon } from '../components/icons.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import { findByCode } from '../data/cart.ts';
import { ledgerContext, listCategories } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import {
  type CountDraft,
  type CountScope,
  discardCount,
  finishCount,
  loadCountDraft,
  startCount,
  updateCount,
} from '../data/stock.ts';
import { beep } from '../sell/beep.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';

/** Stock count (screens/09): scope → counted list → Finish count. */
export function StockCountPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const draft = useLiveQuery(() => loadCountDraft(getDb()), []);
  const products = useLiveQuery(async () => {
    const d = await loadCountDraft(getDb());
    if (!d) return [] as MasterRow[];
    const rows = await getDb().products.bulkGet(Object.keys(d.expected));
    return rows
      .filter((p): p is MasterRow => Boolean(p))
      .sort((a, b) => String(a.name_en).localeCompare(String(b.name_en)));
  }, [draft?.started_at]);
  const categories = useLiveQuery(() => listCategories(getDb()), []);
  const [scopeKind, setScopeKind] = useState<CountScope['kind']>('all');
  const [categoryId, setCategoryId] = useState('');
  const [zero, setZero] = useState(false);
  const [scan, setScan] = useState('');
  const scanId = useId();

  if (!can('stock.adjust') || readOnly) return <Navigate to="/" replace />;
  if (draft === undefined) return null;

  const setCounted = async (
    _d: CountDraft,
    id: string,
    milli: number | null,
  ) => {
    await updateCount(getDb(), id, () => milli);
  };

  if (!draft) {
    return (
      <Box mx="auto" maw={672} p="md" w="100%">
        <Stack gap="md">
          <SubpageHeader
            backTo="/products"
            backLabel={t('import.back_to_products')}
            icon={<ProductsIcon />}
            title={t('count.title')}
          />
          <Paper withBorder p="lg">
            <Stack gap="md">
              <Radio.Group
                label={t('count.scope')}
                value={scopeKind}
                onChange={(value) => setScopeKind(value as CountScope['kind'])}
              >
                <Stack gap="xs" mt="xs">
                  {(['all', 'category', 'low'] as const).map((k) => (
                    <Radio key={k} value={k} label={t(`count.scope_${k}`)} />
                  ))}
                </Stack>
              </Radio.Group>
              {scopeKind === 'category' ? (
                <NativeSelect
                  label={t('count.category')}
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.currentTarget.value)}
                  data={[
                    { value: '', label: '—' },
                    ...(categories?.map((c) => ({
                      value: c.id,
                      label: String(c.name_en),
                    })) ?? []),
                  ]}
                />
              ) : null}
              <Button
                type="button"
                disabled={scopeKind === 'category' && !categoryId}
                onClick={() =>
                  void startCount(
                    getDb(),
                    scopeKind === 'category'
                      ? { kind: 'category', categoryId }
                      : { kind: scopeKind },
                  )
                }
                style={{ alignSelf: 'flex-start' }}
              >
                {t('count.start')}
              </Button>
            </Stack>
          </Paper>
        </Stack>
      </Box>
    );
  }

  const counted = Object.keys(draft.counted).length;
  const finish = async () => {
    try {
      const ctx = await ledgerContext(getDb(), staff?.id ?? '');
      const r = await finishCount(getDb(), draft, { zeroUncounted: zero }, ctx);
      toast.push(t('count.finished', { count: r.movements }), 'info');
    } catch {
      toast.push(t('count.save_failed'), 'error');
    }
  };
  const onScan = async (code: string) => {
    const product = await findByCode(getDb(), code.trim());
    if (!product || !(product.id in draft.expected)) {
      toast.push(t('count.not_in_count', { code }), 'error');
      return;
    }
    beep();
    await updateCount(getDb(), product.id, (current) => (current ?? 0) + 1000);
  };

  return (
    <Box mx="auto" maw={768} p="md" w="100%">
      <Stack gap="md">
        <SubpageHeader
          backTo="/products"
          backLabel={t('import.back_to_products')}
          icon={<ProductsIcon />}
          title={t('count.title')}
        />
        <Text c="dimmed" data-testid="count-progress">
          {t('count.progress', {
            counted,
            total: Object.keys(draft.expected).length,
          })}
        </Text>
        <Box
          component="form"
          onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (scan.trim()) void onScan(scan);
            setScan('');
          }}
        >
          <TextInput
            id={scanId}
            label={t('count.scan')}
            value={scan}
            onChange={(event) => setScan(event.currentTarget.value)}
            autoComplete="off"
            styles={{
              input: { fontFamily: 'var(--mantine-font-family-monospace)' },
            }}
          />
        </Box>
        <Paper withBorder p={0}>
          <Box
            component="ul"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {products?.map((p, index) => {
              const unit = String(p.unit ?? 'pc') as QtyUnit;
              const expected = draft.expected[p.id] ?? 0;
              const value = Object.hasOwn(draft.counted, p.id)
                ? (draft.counted[p.id] ?? 0)
                : null;
              const diff = value === null ? null : value - expected;
              return (
                <Box
                  component="li"
                  key={p.id}
                  data-testid="count-row"
                  p="sm"
                  style={{
                    borderTop:
                      index > 0
                        ? '1px solid var(--mantine-color-default-border)'
                        : undefined,
                  }}
                >
                  <Stack gap="xs">
                    <Text fw={500}>{String(p.name_en)}</Text>
                    <Group gap="md" align="flex-start" wrap="wrap">
                      <Box>
                        <Text size="sm" c="dimmed">
                          {t('count.expected')}
                        </Text>
                        <Text
                          size="sm"
                          ff="monospace"
                          component="bdi"
                          dir="ltr"
                          data-testid="count-expected"
                        >
                          {formatQtyFromMilli(expected, unit)}
                        </Text>
                      </Box>
                      <Box style={{ flex: '1 1 11rem', maxWidth: 208 }}>
                        <QtyInput
                          dense
                          label={t('count.counted')}
                          ariaLabel={t('count.counted_for', {
                            name: String(p.name_en),
                          })}
                          unit={unit}
                          value={value}
                          onChange={(v) => void setCounted(draft, p.id, v)}
                        />
                      </Box>
                      <Box>
                        <Text size="sm" c="dimmed">
                          {t('count.difference')}
                        </Text>
                        <Text
                          size="sm"
                          ff="monospace"
                          component="bdi"
                          dir="ltr"
                          data-testid="count-diff"
                          c={
                            diff === null
                              ? undefined
                              : diff < 0
                                ? 'danger'
                                : diff > 0
                                  ? 'var(--color-success)'
                                  : undefined
                          }
                        >
                          {diff === null
                            ? '—'
                            : `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${formatQtyFromMilli(Math.abs(diff), unit)}`}
                        </Text>
                      </Box>
                    </Group>
                  </Stack>
                </Box>
              );
            })}
          </Box>
        </Paper>
        <Checkbox
          label={t('count.zero_uncounted')}
          checked={zero}
          onChange={(event) => setZero(event.currentTarget.checked)}
        />
        <Group gap="sm">
          <Button type="button" onClick={() => void finish()}>
            {t('count.finish')}
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => void discardCount(getDb())}
          >
            {t('count.discard')}
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}
