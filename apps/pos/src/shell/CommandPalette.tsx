import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ClockIcon,
  ExpensesIcon,
  PrinterIcon,
  ProductsIcon,
  ReportsIcon,
  SalesIcon,
  SearchIcon,
  SellIcon,
  SettingsIcon,
  SuppliersIcon,
  UdhaarIcon,
  UsersIcon,
} from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useSession } from '../state/session.ts';
import { ignoresHotkey } from './hotkeys.ts';
import { usePriceCheck } from './priceCheckStore.ts';

type Command = {
  id: string;
  label: string;
  hint?: string;
  keys?: string;
  icon?: ReactNode;
  run: () => void;
};

/** `Ctrl/Cmd+K` command palette and `?` shortcut sheet (docs/08 §6). */
export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useCurrentStaff();
  const lock = useSession((state) => state.lock);
  const openPriceCheck = usePriceCheck((state) => state.setOpen);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'commands' | 'shortcuts'>('commands');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => {
      setOpen(false);
      void navigate({ to });
    };
    const items: Command[] = [
      {
        id: 'sell',
        label: t('home.new_sale'),
        hint: t('nav.sell'),
        keys: 'N',
        icon: <SellIcon />,
        run: go('/sell'),
      },
      {
        id: 'products',
        label: t('nav.products'),
        hint: t('home.desc_products'),
        keys: 'Ctrl+Shift+3',
        icon: <ProductsIcon />,
        run: go('/products'),
      },
      {
        id: 'sales',
        label: t('nav.sales'),
        hint: t('home.desc_sales'),
        keys: 'Ctrl+Shift+4',
        icon: <SalesIcon />,
        run: go('/sales'),
      },
      {
        id: 'udhaar',
        label: t('nav.udhaar'),
        hint: t('home.desc_udhaar'),
        keys: 'Ctrl+Shift+5',
        icon: <UdhaarIcon />,
        run: go('/udhaar'),
      },
      {
        id: 'suppliers',
        label: t('nav.suppliers'),
        hint: t('home.desc_suppliers'),
        keys: 'Ctrl+Shift+6',
        icon: <SuppliersIcon />,
        run: go('/suppliers'),
      },
      {
        id: 'expenses',
        label: t('nav.expenses'),
        hint: t('home.desc_expenses'),
        keys: 'Ctrl+Shift+7',
        icon: <ExpensesIcon />,
        run: go('/expenses'),
      },
      {
        id: 'reports',
        label: t('nav.reports'),
        hint: t('home.desc_reports'),
        keys: 'Ctrl+Shift+8',
        icon: <ReportsIcon />,
        run: go('/reports'),
      },
      {
        id: 'day-close',
        label: t('home.day_close'),
        hint: t('home.desc_day_close'),
        keys: 'D',
        icon: <ClockIcon />,
        run: go('/day-close'),
      },
      {
        id: 'settings',
        label: t('nav.settings'),
        hint: t('home.desc_settings'),
        keys: 'Ctrl+Shift+9',
        icon: <SettingsIcon />,
        run: go('/settings'),
      },
      {
        id: 'printer',
        label: t('printer.title'),
        hint: t('shell.commands_printer_hint'),
        icon: <PrinterIcon />,
        run: go('/settings/printer'),
      },
      {
        id: 'cashiers',
        label: t('shell.commands_cashiers'),
        hint: t('shell.commands_cashiers_hint'),
        icon: <UsersIcon />,
        run: go('/settings/cashiers'),
      },
      {
        id: 'price-check',
        label: t('home.price_check'),
        hint: t('home.desc_price_check'),
        keys: 'Ctrl+Shift+P',
        icon: <SearchIcon />,
        run: () => {
          setOpen(false);
          openPriceCheck(true);
        },
      },
      {
        id: 'lock',
        label: t('shell.lock'),
        hint: t('shell.staff_menu'),
        keys: 'Ctrl+L',
        run: () => {
          setOpen(false);
          lock();
        },
      },
    ];
    return items.filter((item) => {
      if (item.id === 'sell') return can('sale.create');
      if (item.id === 'udhaar') return can('payment.receive');
      if (item.id === 'suppliers') return can('purchase.create');
      if (item.id === 'expenses') return can('expense.create');
      if (item.id === 'reports') return can('report.view');
      if (item.id === 'day-close') return can('dayclose.create');
      if (item.id === 'cashiers') return can('settings.staff');
      return true;
    });
  }, [can, lock, navigate, openPriceCheck, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.hint ?? ''}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMode('commands');
        setQuery('');
        setActive(0);
        setOpen(true);
        return;
      }
      if (event.key === '?' && !ignoresHotkey(event.target)) {
        event.preventDefault();
        setMode('shortcuts');
        setActive(0);
        setOpen(true);
      }
    };
    const openCommands = () => {
      setMode('commands');
      setQuery('');
      setActive(0);
      setOpen(true);
    };
    const openShortcuts = () => {
      setMode('shortcuts');
      setActive(0);
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('bikri:commands', openCommands);
    window.addEventListener('bikri:shortcuts', openShortcuts);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('bikri:commands', openCommands);
      window.removeEventListener('bikri:shortcuts', openShortcuts);
    };
  }, []);

  useEffect(() => {
    if (open && mode === 'commands') inputRef.current?.focus();
  }, [open, mode]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="bikri-overlay fixed inset-0 z-50 bg-text/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="bikri-dialog fixed inset-x-3 top-16 z-50 mx-auto flex max-h-[calc(100dvh-6rem)] w-auto max-w-xl flex-col overflow-hidden rounded-modal border border-border bg-surface p-0 text-text shadow-modal"
        >
          <Dialog.Title className="sr-only">
            {mode === 'commands' ? t('shell.commands') : t('shell.shortcuts')}
          </Dialog.Title>
          {mode === 'commands' ? (
            <>
              <div className="flex items-center gap-2 border-b border-border px-3">
                <SearchIcon />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      if (filtered.length === 0) return;
                      const delta = event.key === 'ArrowDown' ? 1 : -1;
                      setActive(
                        (active + delta + filtered.length) % filtered.length,
                      );
                    } else if (event.key === 'Enter') {
                      event.preventDefault();
                      filtered[active]?.run();
                    }
                  }}
                  placeholder={t('shell.commands_placeholder')}
                  aria-label={t('shell.commands_placeholder')}
                  aria-controls={listId}
                  aria-activedescendant={
                    filtered[active]
                      ? `${listId}-${filtered[active].id}`
                      : undefined
                  }
                  className="h-14 min-w-0 flex-1 bg-transparent text-title outline-none"
                />
                <KeyBadge keys="Esc" />
              </div>
              <div
                id={listId}
                role="listbox"
                aria-label={t('shell.commands')}
                className="flex flex-col gap-0.5 overflow-y-auto p-1"
              >
                {filtered.map((command, index) => (
                  <button
                    key={command.id}
                    id={`${listId}-${command.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={command.run}
                    className={`flex min-h-11 items-center gap-3 rounded-control px-3 text-start ${
                      index === active ? 'bg-primary-subtle' : ''
                    }`}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center text-text-muted">
                      {command.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-small font-medium">
                        {command.label}
                      </span>
                      {command.hint ? (
                        <span className="block text-small text-text-muted">
                          {command.hint}
                        </span>
                      ) : null}
                    </span>
                    {command.keys ? (
                      <KeyBadge keys={command.keys} always />
                    ) : null}
                  </button>
                ))}
                {filtered.length === 0 ? (
                  <p className="px-3 py-4 text-small text-text-muted">
                    {t('shell.commands_none')}
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-3 overflow-y-auto p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-title font-semibold">
                  {t('shell.shortcuts')}
                </p>
                <KeyBadge keys="Esc" />
              </div>
              {[
                {
                  title: t('shell.shortcuts_global'),
                  rows: [
                    ['Ctrl+K', t('shell.commands')],
                    ['?', t('shell.shortcuts')],
                    ['/', t('shell.search_label')],
                    ['N', t('home.new_sale')],
                    ['Ctrl+Shift+P', t('home.price_check')],
                    ['Ctrl+L', t('shell.lock')],
                  ],
                },
                {
                  title: t('shell.shortcuts_sell'),
                  rows: [
                    ['F2', t('sell.search_label')],
                    ['Ctrl+1/2/3', t('sell.carts')],
                    ['F3', t('sell.add_discount')],
                    ['F4', t('sell.hold')],
                    ['F6', t('sell.held_title')],
                    ['F7', t('sell.quick_sale')],
                    ['F8', t('sell.take_payment')],
                    ['1–4', t('pay.method')],
                    ['F9', t('printer.open_drawer')],
                  ],
                },
                {
                  title: t('shell.shortcuts_details'),
                  rows: [
                    ['Ctrl+S', t('form.save')],
                    ['Esc', t('common.close')],
                    ['P', t('shell.shortcut_print')],
                    ['R', t('shell.shortcut_refund')],
                    ['L', t('products.print_label')],
                  ],
                },
              ].map((group) => (
                <section key={group.title}>
                  <h3 className="mb-1 text-small font-semibold text-text-muted">
                    {group.title}
                  </h3>
                  <ul className="flex flex-col gap-1 text-small">
                    {group.rows.map(([keys = '', label = '']) => (
                      <li key={keys} className="flex items-center gap-3">
                        <KeyBadge keys={keys} always />
                        <span>{label}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
