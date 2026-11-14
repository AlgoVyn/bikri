import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useDeferredValue, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon, SearchIcon } from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { getDb } from '../data/db.ts';
import { type SearchHit, searchAll } from '../data/search.ts';
import { useBusinessDates } from '../data/useBusinessDates.ts';
import { useShopTimeZone } from '../data/useShopTimeZone.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { seesAllDates } from '../state/reportScope.ts';
import { ignoresHotkey } from './hotkeys.ts';
import { useGlobalSearch } from './searchStore.ts';

/** Rail or top-bar trigger for the global search overlay (screens/04). */
export function GlobalSearchTrigger({
  variant,
}: {
  variant: 'topbar' | 'rail';
}) {
  const { t } = useTranslation();
  const openSearch = useGlobalSearch((state) => state.openSearch);
  if (variant === 'rail') {
    return (
      <button
        type="button"
        data-testid="rail-search"
        title={`${t('shell.search_label')} (/)`}
        aria-label={`${t('shell.search_label')} (/)`}
        onClick={openSearch}
        className="relative flex min-h-11 w-full flex-col items-center justify-center gap-0.5 px-1 text-small text-rail-muted transition-colors duration-150 hover:bg-rail-hover hover:text-rail-ink"
      >
        <SearchIcon />
        <span className="rail-label max-w-full truncate leading-tight">
          {t('shell.search_short')}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      data-testid="global-search-trigger"
      className="flex size-11 items-center justify-center rounded-control text-text-muted"
      aria-label={t('shell.search_label')}
      aria-haspopup="dialog"
      onClick={openSearch}
    >
      <SearchIcon />
    </button>
  );
}

/**
 * The one search overlay. It is mounted at the shell root, so the same panel opens
 * from the desktop rail and from the phone/tablet top bar.
 */
export function GlobalSearchHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const open = useGlobalSearch((state) => state.open);
  const openSearch = useGlobalSearch((state) => state.openSearch);
  const closeSearch = useGlobalSearch((state) => state.closeSearch);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const { can, role, support, branchId } = useCurrentStaff();
  const allDates = seesAllDates(role, support, can('report.view'));
  const timeZone = useShopTimeZone();
  const { today } = useBusinessDates(timeZone);
  const deferredQuery = useDeferredValue(query);
  const hits =
    useLiveQuery(async () => {
      if (!deferredQuery.trim()) return [];
      const db = getDb();
      return searchAll(db, deferredQuery, {
        allDates,
        today,
        branchId: allDates ? null : branchId,
      });
    }, [deferredQuery, allDates, branchId, today]) ?? [];
  const optionId = (index: number) => `${listId}-opt-${index}`;

  useEffect(() => {
    if (!open || active < 0) return;
    document
      .getElementById(`${listId}-opt-${active}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open, listId]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeSearch();
      setQuery('');
      setActive(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeSearch]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== '/' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        ignoresHotkey(event.target)
      )
        return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);

  if (!open) return null;

  const close = () => {
    closeSearch();
    setQuery('');
    setActive(0);
  };

  const go = (hit: SearchHit) => {
    close();
    if (hit.kind === 'product')
      void navigate({ to: '/products/$id', params: { id: hit.id } });
    else if (hit.kind === 'customer')
      void navigate({
        to: '/udhaar/$customerId',
        params: { customerId: hit.id },
      });
    else void navigate({ to: '/sales/$id', params: { id: hit.id } });
  };

  const groups: { kind: SearchHit['kind']; label: string }[] = [
    { kind: 'product', label: t('shell.search_products') },
    { kind: 'customer', label: t('shell.search_customers') },
    { kind: 'bill', label: t('shell.search_bills') },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-center px-3 pt-20 lg:pt-6">
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('common.close')}
        className="absolute inset-0 bg-text/35"
        onClick={close}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.search_label')}
        className="relative flex h-fit max-h-[calc(100dvh-7rem)] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-modal"
      >
        <div className="flex min-h-14 items-center gap-2 border-b border-border px-3">
          <SearchIcon className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            id="global-search"
            type="search"
            role="combobox"
            aria-label={t('shell.search_label')}
            aria-expanded={query.trim() !== ''}
            aria-controls={listId}
            aria-activedescendant={
              query.trim() !== '' && hits[active] ? optionId(active) : undefined
            }
            aria-autocomplete="list"
            autoComplete="off"
            placeholder={t('shell.search_label')}
            className="bikri-focus-wrapper h-12 min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-muted"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (event.key === 'Enter') {
                const hit = hits[active];
                if (hit) {
                  event.preventDefault();
                  go(hit);
                }
              }
            }}
          />
          <KeyBadge keys="Esc" always />
          <button
            type="button"
            className="flex size-11 shrink-0 items-center justify-center rounded-control text-text-muted hover:bg-surface-2 hover:text-text"
            aria-label={t('common.close')}
            onClick={close}
          >
            <CloseIcon className="size-5" />
          </button>
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label={t('shell.search_label')}
          className="max-h-[60dvh] overflow-y-auto py-1"
        >
          {query.trim() !== '' && hits.length === 0 ? (
            <p className="px-3 py-2 text-text-muted">
              {t('shell.search_none')}
            </p>
          ) : null}
          {groups.map((group) => {
            const inGroup = hits.filter((h) => h.kind === group.kind);
            if (inGroup.length === 0) return null;
            return (
              // biome-ignore lint/a11y/useSemanticElements: an ARIA listbox group, not a form fieldset
              <div key={group.kind} role="group" aria-label={group.label}>
                <p className="px-3 pt-2 text-small text-text-muted">
                  {group.label}
                </p>
                {inGroup.map((hit) => {
                  const index = hits.indexOf(hit);
                  return (
                    <div
                      key={`${hit.kind}-${hit.id}`}
                      id={optionId(index)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === active}
                      className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-3 aria-selected:bg-primary-subtle"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        go(hit);
                      }}
                    >
                      <span className="truncate">{hit.title}</span>
                      <span className="flex shrink-0 items-baseline gap-2">
                        {hit.kind === 'product' && hit.price !== undefined ? (
                          <span className="font-medium tabular-nums">
                            <MoneyText paisa={hit.price} />
                          </span>
                        ) : hit.detail ? (
                          <bdi dir="ltr" className="text-small text-text-muted">
                            {hit.detail}
                          </bdi>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
