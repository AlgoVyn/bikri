import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchIcon } from '../components/icons.tsx';
import { getDb } from '../data/db.ts';
import { type SearchHit, searchAll } from '../data/search.ts';
import { ignoresHotkey } from './hotkeys.ts';

/** Top-bar search over products, customers and bills (screens/04). `/` focuses it. */
export function GlobalSearch() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [active, setActive] = useState(0);
  const hits = useLiveQuery(() => searchAll(getDb(), query), [query]) ?? [];

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
      setPhoneOpen(true);
      setTimeout(() => document.getElementById('global-search')?.focus(), 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (hit: SearchHit) => {
    setQuery('');
    setOpen(false);
    setPhoneOpen(false);
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
    <search className="relative">
      <button
        type="button"
        className="flex size-11 items-center justify-center rounded-control text-text-muted lg:hidden"
        aria-label={t('shell.search_label')}
        aria-expanded={phoneOpen}
        onClick={() => {
          setPhoneOpen(true);
          setTimeout(
            () => document.getElementById('global-search')?.focus(),
            0,
          );
        }}
      >
        <SearchIcon />
      </button>
      <div
        className={`${phoneOpen ? 'max-lg:flex' : 'max-lg:hidden'} items-center gap-2 rounded-control border border-border-strong bg-surface px-3 max-lg:fixed max-lg:inset-x-2 max-lg:top-1.5 max-lg:z-40 h-11 lg:flex lg:w-80`}
      >
        <SearchIcon />
        <input
          id="global-search"
          type="search"
          role="combobox"
          aria-label={t('shell.search_label')}
          aria-expanded={open && query.trim() !== ''}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={t('shell.search_label')}
          className="min-w-0 flex-1 bg-transparent text-body text-text outline-none"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() =>
            setTimeout(() => {
              setOpen(false);
              setPhoneOpen(false);
            }, 150)
          }
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('');
              setOpen(false);
              setPhoneOpen(false);
              event.currentTarget.blur();
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
      </div>
      {open && query.trim() !== '' ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t('shell.search_label')}
          className="fixed inset-x-2 top-topbar z-40 max-h-[60dvh] overflow-y-auto rounded-card border border-border bg-surface py-1 shadow-lg lg:absolute lg:inset-x-auto lg:end-0 lg:top-12 lg:w-80"
        >
          {hits.length === 0 ? (
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
                      {hit.detail ? (
                        <bdi
                          dir="ltr"
                          className="shrink-0 text-small text-text-muted"
                        >
                          {hit.detail}
                        </bdi>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}
    </search>
  );
}
