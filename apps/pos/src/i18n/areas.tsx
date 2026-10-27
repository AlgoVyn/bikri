/** Strings of a lazily loaded feature area (D-112), merged into the active language on demand. */
import {
  type CatalogArea,
  type LocaleCode,
  loadAreaCatalog,
} from '@bikri/i18n';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const loaded = new Set<string>();

export function useAreaStrings(area: CatalogArea): boolean {
  const { i18n } = useTranslation();
  const lang = i18n.language as LocaleCode;
  const id = `${area}:${lang}`;
  const [ready, setReady] = useState(() => loaded.has(id));
  useEffect(() => {
    if (loaded.has(id)) {
      setReady(true);
      return;
    }
    setReady(false);
    let alive = true;
    void loadAreaCatalog(area, lang).then((bundle) => {
      i18n.addResourceBundle(lang, 'translation', bundle, true, false);
      loaded.add(id);
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [area, lang, id, i18n]);
  return ready;
}

/** Renders `children` once the area's strings are in. */
export function AreaStrings({
  area,
  children,
}: {
  area: CatalogArea;
  children: ReactNode;
}) {
  const ready = useAreaStrings(area);
  const { t } = useTranslation();
  if (!ready) return <p className="sr-only">{t('common.loading')}</p>;
  return <>{children}</>;
}
