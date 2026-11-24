import * as Dialog from '@radix-ui/react-dialog';
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
import { composing } from './hotkeys.ts';
import { useGlobalSearch } from './searchStore.ts';

/** Rail or top-bar trigger for the global search overlay (screens/04). */
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
        includeCustomers: can('payment.receive'),
      });
    }, [deferredQuery, allDates, branchId, today, can]) ?? [];
  const optionId = (index: number) => `${listId}-opt-${index}`;

  useEffect(() => {
    if (!open || active < 0) return;
    document
      .getElementById(`${listId}-opt-${active}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open, listId]);

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
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="bikri-overlay fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
          className="bikri-dialog fixed inset-x-3 top-20 z-50 mx-auto flex h-fit max-h-[calc(100dvh-7rem)] w-auto max-w-2xl flex-col overflow-hidden rounded-modal border border-border bg-surface p-0 text-text shadow-modal lg:top-6"
        >
          <Dialog.Title className="sr-only">
            {t('shell.search_label')}
          </Dialog.Title>
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
                query.trim() !== '' && hits[active]
                  ? optionId(active)
                  : undefined
              }
              aria-autocomplete="list"
              autoComplete="off"
              placeholder={t('shell.search_label')}
              className="bikri-focus-wrapper search-no-cancel h-12 min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-muted"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (composing(event)) return;
                if (event.key === 'Escape') {
                  event.preventDefault();
                  close();
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActive((i) =>
                    Math.min(i + 1, Math.max(hits.length - 1, 0)),
                  );
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
                        className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-3 aria-selected:bg-primary-subtle aria-selected:text-primary-subtle-ink"
                        onClick={() => go(hit)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            go(hit);
                          }
                        }}
                      >
                        <span className="truncate">{hit.title}</span>
                        <span className="flex shrink-0 items-baseline gap-2">
                          {hit.kind === 'product' && hit.price !== undefined ? (
                            <span className="font-medium tabular-nums">
                              <MoneyText paisa={hit.price} />
                            </span>
                          ) : hit.detail ? (
                            <bdi
                              dir="ltr"
                              className="text-small text-text-muted"
                            >
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
