import type { Permission } from '@bikri/core';
import {
  ExpensesIcon,
  HomeIcon,
  ProductsIcon,
  ReportsIcon,
  SalesIcon,
  SellIcon,
  SettingsIcon,
  SuppliersIcon,
  UdhaarIcon,
} from '../components/icons.tsx';

export type NavItem = {
  to: string;
  label: string;
  keys: string;
  Icon: () => React.JSX.Element;
  /** Hidden (and its route refused) without this permission (screens/04). */
  perm: Permission | null;
  /** Shown in the phone bottom bar; the rest live under More. */
  bar: boolean;
};

export const NAV: readonly NavItem[] = [
  {
    to: '/',
    label: 'nav.home',
    keys: 'Alt+1',
    Icon: HomeIcon,
    perm: null,
    bar: true,
  },
  {
    to: '/sell',
    label: 'nav.sell',
    keys: 'Alt+2',
    Icon: SellIcon,
    perm: 'sale.create',
    bar: true,
  },
  {
    to: '/products',
    label: 'nav.products',
    keys: 'Alt+3',
    Icon: ProductsIcon,
    perm: null,
    bar: true,
  },
  {
    to: '/sales',
    label: 'nav.sales',
    keys: 'Alt+4',
    Icon: SalesIcon,
    perm: null,
    bar: true,
  },
  {
    to: '/udhaar',
    label: 'nav.udhaar',
    keys: 'Alt+5',
    Icon: UdhaarIcon,
    perm: 'payment.receive',
    bar: true,
  },
  {
    to: '/suppliers',
    label: 'nav.suppliers',
    keys: 'Alt+6',
    Icon: SuppliersIcon,
    perm: 'purchase.create',
    bar: false,
  },
  {
    to: '/expenses',
    label: 'nav.expenses',
    keys: 'Alt+7',
    Icon: ExpensesIcon,
    perm: 'expense.create',
    bar: false,
  },
  {
    to: '/reports',
    label: 'nav.reports',
    keys: 'Alt+8',
    Icon: ReportsIcon,
    perm: 'report.view',
    bar: false,
  },
  {
    to: '/settings',
    label: 'nav.settings',
    keys: 'Alt+9',
    Icon: SettingsIcon,
    perm: null,
    bar: false,
  },
];

/** The nav item a path belongs to (`/products/123` → Products). */
export function navItemFor(pathname: string): NavItem | undefined {
  const path = pathname.replace(/\/+$/u, '') || '/';
  if (path === '/') return NAV[0];
  return NAV.find(
    (item) =>
      item.to !== '/' && (path === item.to || path.startsWith(`${item.to}/`)),
  );
}
