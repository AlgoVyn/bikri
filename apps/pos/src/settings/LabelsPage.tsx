import { barcodeLabelSvg, LABEL_SIZES } from '@bikri/printer';
import {
  Button,
  Checkbox,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TagIcon } from '../components/icons.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { getKv, setKv } from '../data/kv.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { printLabelHtml } from '../labels/printLabels.ts';
import { SettingsGuard } from './Guard.tsx';
import { SettingsPageLayout } from './Layout.tsx';

export type LabelSettings = {
  size: '50x25' | '38x25' | '40x30' | 'a4';
  showShop: boolean;
  showPrice: boolean;
  dpi: 203 | 300;
  start: number;
};

const DEFAULT: LabelSettings = {
  size: '50x25',
  showShop: false,
  showPrice: true,
  dpi: 203,
  start: 0,
};

/** Label size/contents for this device (screens/17/20; printing lands with T-052). */
export function LabelsPage() {
  return (
    <AreaStrings area="office">
      <SettingsGuard permission="catalog.edit">
        <LabelsContent />
      </SettingsGuard>
    </AreaStrings>
  );
}

function LabelsContent() {
  const { t } = useTranslation();
  const toast = useToast();
  const stored = useLiveQuery(
    () => getKv<LabelSettings>(getDb(), 'label', DEFAULT),
    [],
  );
  const [form, setForm] = useState<LabelSettings>(DEFAULT);
  useEffect(() => {
    if (stored) setForm(stored);
  }, [stored]);
  const save = async () => {
    await setKv(getDb(), 'label', form);
    toast.push(t('office.labels.saved'));
  };
  const printTest = () => {
    try {
      const barcode = 'BIKRI-TEST';
      const svg = barcodeLabelSvg(barcode, LABEL_SIZES[form.size], form.dpi);
      printLabelHtml(
        [
          `<div class="label">
            ${form.showShop ? `<div class="shop"></div>` : ''}
            <div class="name">${t('office.labels.print_test')}</div>
            ${form.showPrice ? '<div class="price">Rs 1,000.00</div>' : ''}
            <div class="bars">${svg.svg}</div>
            <div class="value">${barcode}</div>
          </div>`,
        ],
        form,
      );
    } catch {
      toast.push(t('office.labels.charset'), 'error');
    }
  };
  return (
    <SettingsPageLayout title={t('office.labels.title')} icon={<TagIcon />}>
      <Paper withBorder p="lg">
        <Stack gap="sm">
          <NativeSelect
            label={t('office.labels.size')}
            value={form.size}
            onChange={(event) =>
              setForm({
                ...form,
                size: event.currentTarget.value as LabelSettings['size'],
              })
            }
            data={[
              { value: '50x25', label: t('office.labels.size_50x25') },
              { value: '38x25', label: t('office.labels.size_38x25') },
              { value: '40x30', label: t('office.labels.size_40x30') },
              { value: 'a4', label: t('office.labels.size_a4') },
            ]}
          />
          <Checkbox
            label={t('office.labels.show_shop')}
            checked={form.showShop}
            onChange={(event) =>
              setForm({ ...form, showShop: event.currentTarget.checked })
            }
          />
          <Checkbox
            label={t('office.labels.show_price')}
            checked={form.showPrice}
            onChange={(event) =>
              setForm({ ...form, showPrice: event.currentTarget.checked })
            }
          />
          <NativeSelect
            label={t('office.labels.dpi')}
            value={form.dpi}
            onChange={(event) =>
              setForm({
                ...form,
                dpi: Number(event.currentTarget.value) as 203 | 300,
              })
            }
            data={[
              { value: '203', label: '203 dpi' },
              { value: '300', label: '300 dpi' },
            ]}
          />
          {form.size === 'a4' ? (
            <NumberInput
              label={t('office.labels.start')}
              min={0}
              max={23}
              value={form.start}
              onChange={(value) =>
                setForm({
                  ...form,
                  start: Math.max(0, Math.min(23, Number(value) || 0)),
                })
              }
            />
          ) : null}
          <Group gap="sm">
            <Button type="button" onClick={() => void save()}>
              {t('office.labels.save')}
            </Button>
            <Button type="button" variant="default" onClick={printTest}>
              {t('office.labels.print_test')}
            </Button>
          </Group>
          <Text size="sm" c="dimmed">
            {t('office.labels.print_hint')}
          </Text>
        </Stack>
      </Paper>
    </SettingsPageLayout>
  );
}
