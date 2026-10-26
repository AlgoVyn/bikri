import { catalogs, type LocaleCode } from '@bikri/i18n';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { useState } from 'react';
import {
  I18nextProvider,
  initReactI18next,
  useTranslation,
} from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ExportMenu } from '../components/ExportMenu.tsx';
import { ClockIcon } from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { OverrideDialog } from '../components/OverrideDialog.tsx';
import { PhoneInput } from '../components/PhoneInput.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { SearchBox } from '../components/SearchBox.tsx';
import { ToastProvider, useToast } from '../components/Toast.tsx';

const resources = {
  en: { translation: catalogs.en },
  ur: { translation: catalogs.ur },
  'roman-ur': { translation: catalogs['roman-ur'] },
};

function frameI18n(locale: LocaleCode): I18nInstance {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    initAsync: false,
    react: { useSuspense: false },
  });
  return instance;
}

const english = frameI18n('en');
const urdu = frameI18n('ur');

function KitFields({ idPrefix }: { idPrefix: string }) {
  const { t } = useTranslation();
  const { push } = useToast();
  const [money, setMoney] = useState<number | null>(4_300_000);
  const [negative, setNegative] = useState<number | null>(-50_000);
  const [pieces, setPieces] = useState<number | null>(1000);
  const [kilos, setKilos] = useState<number | null>(1500);
  const [mobile, setMobile] = useState<string | null>(null);
  const [landline, setLandline] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <p>
        <MoneyText paisa={4_300_000} /> <MoneyText paisa={345_977} />{' '}
        <MoneyText paisa={-50_000} />
      </p>
      <MoneyInput
        id={`${idPrefix}-money`}
        label={t('ui.money_label')}
        value={money}
        onChange={setMoney}
      />
      <MoneyInput
        id={`${idPrefix}-negative`}
        label={t('ui.allow_negative')}
        value={negative}
        allowNegative
        onChange={setNegative}
      />
      <QtyInput
        id={`${idPrefix}-pc`}
        label={t('ui.qty_label')}
        unit="pc"
        value={pieces}
        onChange={setPieces}
      />
      <QtyInput
        id={`${idPrefix}-kg`}
        label={`${t('ui.qty_label')} kg`}
        unit="kg"
        value={kilos}
        onChange={setKilos}
      />
      <PhoneInput
        id={`${idPrefix}-mobile`}
        label={t('ui.phone_label')}
        value={mobile ?? ''}
        onChange={setMobile}
      />
      <PhoneInput
        id={`${idPrefix}-landline`}
        label={t('ui.phone_label')}
        kind="any"
        value={landline ?? ''}
        onChange={setLandline}
      />
      <SearchBox
        id={`${idPrefix}-search`}
        label={t('ui.search_label')}
        placeholder={t('ui.search_placeholder')}
        value={query}
        onChange={setQuery}
        onSearch={() => {}}
        onBarcode={() => {}}
      />
      <div className="flex flex-wrap items-center gap-2">
        <KeyBadge keys="Alt+1" />
        <button
          type="button"
          className={buttonQuiet}
          onClick={() => setConfirmOpen(true)}
        >
          {t('ui.show_dialog')}
        </button>
        <button
          type="button"
          className={buttonQuiet}
          onClick={() => setOverrideOpen(true)}
        >
          {t('ui.show_override')}
        </button>
        <ExportMenu onCsv={() => {}} onPdf={() => {}} onShare={() => {}} />
        <button
          type="button"
          className={buttonPrimary}
          onClick={() => push(t('ui.sample_toast'))}
        >
          {t('ui.sample_toast')}
        </button>
        <button
          type="button"
          className={buttonQuiet}
          onClick={() => push(t('ui.sample_error'), 'error')}
        >
          {t('ui.sample_error')}
        </button>
      </div>
      <EmptyState
        icon={<ClockIcon />}
        message={t('ui.empty_message')}
        actionLabel={t('ui.empty_action')}
        onAction={() => {}}
      />
      <div className="grid grid-cols-4 gap-2">
        <div className="flex h-11 items-center justify-center rounded-control bg-t1 text-small text-tile-ink">
          t1
        </div>
        <div className="flex h-11 items-center justify-center rounded-control bg-t2 text-small text-tile-ink">
          t2
        </div>
        <div className="flex h-11 items-center justify-center rounded-control bg-t3 text-small text-tile-ink">
          t3
        </div>
        <div className="flex h-11 items-center justify-center rounded-control bg-t4 text-small text-tile-ink">
          t4
        </div>
        <div className="flex h-11 items-center justify-center rounded-control bg-t5 text-small text-tile-ink">
          t5
        </div>
        <div className="flex h-11 items-center justify-center rounded-control bg-t6 text-small text-tile-ink">
          t6
        </div>
        <div className="flex h-11 items-center justify-center rounded-control bg-t7 text-small text-tile-ink">
          t7
        </div>
        <div className="flex h-11 items-center justify-center rounded-control bg-t8 text-small text-tile-ink">
          t8
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {}}
      />
      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        profiles={[
          { id: 'sana', label: t('ui.sample_manager_a') },
          { id: 'bilal', label: t('ui.sample_manager_b') },
        ]}
        verify={async (pin) => pin === '1234'}
      />
    </div>
  );
}

function KitFrame({
  idPrefix,
  title,
  theme,
  locale,
  dir,
  i18n,
}: {
  idPrefix: string;
  title: string;
  theme: 'light' | 'dark';
  locale: LocaleCode;
  dir: 'ltr' | 'rtl';
  i18n: I18nInstance;
}) {
  return (
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <section
          aria-label={title}
          data-theme={theme}
          lang={locale}
          dir={dir}
          className={
            locale === 'ur'
              ? 'flex flex-col gap-3 rounded-card border border-border bg-bg p-4 text-text [font-size:18px]'
              : 'flex flex-col gap-3 rounded-card border border-border bg-bg p-4 text-text'
          }
        >
          <h2 className="text-title">{title}</h2>
          <KitFields idPrefix={idPrefix} />
        </section>
      </ToastProvider>
    </I18nextProvider>
  );
}

export function UiKitPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6 p-4">
      <h1 className="text-title">{t('shell.ui_kit')}</h1>
      <KitFrame
        idPrefix="light"
        title={t('shell.theme_light')}
        theme="light"
        locale="en"
        dir="ltr"
        i18n={english}
      />
      <KitFrame
        idPrefix="dark"
        title={t('shell.theme_dark')}
        theme="dark"
        locale="en"
        dir="ltr"
        i18n={english}
      />
      <KitFrame
        idPrefix="ur"
        title={t('shell.theme_rtl')}
        theme="light"
        locale="ur"
        dir="rtl"
        i18n={urdu}
      />
    </div>
  );
}

export default UiKitPage;
