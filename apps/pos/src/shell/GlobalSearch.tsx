import { businessDate } from '@bikri/core';
import {
  ActionIcon,
  Box,
  Group,
  Kbd,
  Paper,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchIcon } from '../components/icons.tsx';
import { getDb } from '../data/db.ts';
import { type SearchHit, searchAll } from '../data/search.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
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
  const { can } = useCurrentStaff();
  const allDates = can('report.view');
  const hits =
    useLiveQuery(async () => {
      if (!query.trim()) return [];
      const db = getDb();
      const shop = await db.shop.get('shop');
      const timeZone = String(shop?.timezone ?? '').trim() || 'Asia/Karachi';
      return searchAll(db, query, {
        allDates,
        today: businessDate(Date.now(), timeZone),
      });
    }, [query, allDates]) ?? [];
  const optionId = (index: number) => `${listId}-opt-${index}`;
  useEffect(() => {
    if (!open || active < 0) return;
    document
      .getElementById(`${listId}-opt-${active}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open, listId]);

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
    <Box component="search" style={{ position: 'relative' }}>
      <ActionIcon
        variant="subtle"
        size="lg"
        hiddenFrom="sm"
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
      </ActionIcon>
      <Box
        className={
          phoneOpen
            ? 'fixed inset-x-2 top-[68px] z-50'
            : 'hidden sm:block sm:relative sm:z-auto'
        }
      >
        <TextInput
          id="global-search"
          type="search"
          role="combobox"
          size="sm"
          radius="md"
          autoComplete="off"
          placeholder={t('shell.search_label')}
          leftSection={<SearchIcon />}
          rightSection={
            <Kbd visibleFrom="sm" size="xs">
              /
            </Kbd>
          }
          rightSectionWidth={32}
          aria-label={t('shell.search_label')}
          aria-expanded={open && query.trim() !== ''}
          aria-controls={listId}
          aria-activedescendant={
            open && query.trim() !== '' && hits[active]
              ? optionId(active)
              : undefined
          }
          aria-autocomplete="list"
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
          styles={{
            input: {
              background: 'var(--mantine-color-default)',
              borderColor: 'var(--mantine-color-default-border)',
            },
          }}
          w={{ base: '100%', sm: 380 }}
        />
      </Box>
      {open && query.trim() !== '' ? (
        <Paper
          id={listId}
          role="listbox"
          aria-label={t('shell.search_label')}
          withBorder
          shadow="lg"
          style={{
            position: 'fixed',
            insetInline: 8,
            top: phoneOpen ? 120 : 68,
            zIndex: 60,
            maxHeight: '60dvh',
            overflowY: 'auto',
            padding: 4,
          }}
          className="sm:absolute sm:inset-x-auto sm:top-11 sm:end-0 sm:w-96"
        >
          {hits.length === 0 ? (
            <Text size="sm" c="dimmed" px="sm" py="xs">
              {t('shell.search_none')}
            </Text>
          ) : null}
          {groups.map((group) => {
            const inGroup = hits.filter((h) => h.kind === group.kind);
            if (inGroup.length === 0) return null;
            return (
              // biome-ignore lint/a11y/useSemanticElements: an ARIA listbox group, not a form fieldset
              <div key={group.kind} role="group" aria-label={group.label}>
                <Text size="xs" c="dimmed" px="sm" pt="xs" pb={4}>
                  {group.label}
                </Text>
                {inGroup.map((hit) => {
                  const index = hits.indexOf(hit);
                  return (
                    <UnstyledButton
                      key={`${hit.kind}-${hit.id}`}
                      id={optionId(index)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === active}
                      w="100%"
                      px="sm"
                      py={6}
                      style={{
                        borderRadius: 8,
                        background:
                          index === active
                            ? 'var(--mantine-color-brand-0)'
                            : undefined,
                      }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        go(hit);
                      }}
                    >
                      <Group justify="space-between" gap="sm" wrap="nowrap">
                        <Text size="sm" truncate>
                          {hit.title}
                        </Text>
                        {hit.detail ? (
                          <Text size="xs" c="dimmed" dir="ltr" ff="monospace">
                            {hit.detail}
                          </Text>
                        ) : null}
                      </Group>
                    </UnstyledButton>
                  );
                })}
              </div>
            );
          })}
        </Paper>
      ) : null}
    </Box>
  );
}
