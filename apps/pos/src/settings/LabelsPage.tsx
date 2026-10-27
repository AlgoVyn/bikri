import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { getKv, setKv } from '../data/kv.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { SettingsGuard } from './Guard.tsx';
import { SettingsPageLayout } from './Layout.tsx';

export type LabelSettings = {
  size: '50x25' | '38x25' | '40x30' | 'a4';
  showShop: boolean;
  showPrice: boolean;
};

const DEFAULT: LabelSettings = {
  size: '50x25',
  showShop: true,
  showPrice: true,
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
  const field =
    'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text';
  return (
    <SettingsPageLayout title={t('office.labels.title')}>
      <section className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
        <label className="flex flex-col gap-1 text-small">
          {t('office.labels.size')}
          <select
            className={field}
            value={form.size}
            onChange={(event) =>
              setForm({
                ...form,
                size: event.target.value as LabelSettings['size'],
              })
            }
          >
            <option value="50x25">{t('office.labels.size_50x25')}</option>
            <option value="38x25">{t('office.labels.size_38x25')}</option>
            <option value="40x30">{t('office.labels.size_40x30')}</option>
            <option value="a4">{t('office.labels.size_a4')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-small">
          <input
            type="checkbox"
            checked={form.showShop}
            onChange={(event) =>
              setForm({ ...form, showShop: event.target.checked })
            }
          />
          {t('office.labels.show_shop')}
        </label>
        <label className="flex items-center gap-2 text-small">
          <input
            type="checkbox"
            checked={form.showPrice}
            onChange={(event) =>
              setForm({ ...form, showPrice: event.target.checked })
            }
          />
          {t('office.labels.show_price')}
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => void save()}
          >
            {t('office.labels.save')}
          </button>
          <button
            type="button"
            className={buttonQuiet}
            disabled
            title={t('office.labels.print_soon')}
          >
            {t('office.labels.print_test')}
          </button>
        </div>
        <p className="text-small text-text-muted">
          {t('office.labels.print_soon')}
        </p>
      </section>
    </SettingsPageLayout>
  );
}
