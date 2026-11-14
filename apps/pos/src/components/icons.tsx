import type { SVGProps } from 'react';

function Svg(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function HomeIcon() {
  return (
    <Svg>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M7 10.5V20h10v-9.5" />
    </Svg>
  );
}

export function SellIcon() {
  return (
    <Svg>
      <path d="M6 8h12l-1 12H7L6 8Z" />
      <path d="M9 8V6.5A3 3 0 0 1 12 3.5 3 3 0 0 1 15 6.5V8" />
    </Svg>
  );
}

export function ProductsIcon() {
  return (
    <Svg>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

export function SalesIcon() {
  return (
    <Svg>
      <path d="M7 3.5h7l4 4V20.5H7v-17Z" />
      <path d="M14 3.5V8h4" />
      <path d="M9.5 12.5h5M9.5 16h5" />
    </Svg>
  );
}

export function CountIcon() {
  return (
    <Svg>
      <rect x="5" y="4.5" width="14" height="16" rx="2" />
      <path d="M9 4.5V3h6v1.5" />
      <path d="m8.5 12 2 2 4-4" />
      <path d="M8.5 18h7" />
    </Svg>
  );
}

export function UdhaarIcon() {
  return (
    <Svg>
      <circle cx="12" cy="8" r="3" />
      <path d="M5.5 19.5c1.2-3 3.4-4.5 6.5-4.5s5.3 1.5 6.5 4.5" />
    </Svg>
  );
}

export function SettingsIcon(props?: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M6 4v6M6 14v6M12 4v10M12 18v2M18 4v2M18 10v10" />
      <circle cx="6" cy="12" r="2" />
      <circle cx="12" cy="16" r="2" />
      <circle cx="18" cy="8" r="2" />
    </Svg>
  );
}

export function DisplayIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20M8 9h8M8 12h5" />
    </Svg>
  );
}

export function ChevronLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  );
}

export function ChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

export function UndoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </Svg>
  );
}

export function CalendarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
    </Svg>
  );
}

export function ClockIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5l3 2" />
    </Svg>
  );
}

export function FilterIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 6h16l-6 7v5l-4 2v-7L4 6Z" />
    </Svg>
  );
}

export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5 20 20" />
    </Svg>
  );
}

export function EyeIcon(props?: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </Svg>
  );
}

export function EyeOffIcon(props?: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4.2 7.3C3.1 8.8 2.5 10.2 2.5 12c0 0 3.5 6 9.5 6 1.7 0 3.2-.4 4.5-1" />
      <path d="M9.8 6.3A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a12.8 12.8 0 0 1-2.2 2.9" />
      <path d="M9.9 9.9A3 3 0 0 0 14.1 14" />
      <path d="m4 4 16 16" />
    </Svg>
  );
}

export function SuppliersIcon() {
  return (
    <Svg>
      <path d="M3 7h11v9H3z" />
      <path d="M14 10h4l3 3v3h-7" />
      <circle cx="7" cy="18" r="1.6" />
      <circle cx="17" cy="18" r="1.6" />
    </Svg>
  );
}

export function ExpensesIcon() {
  return (
    <Svg>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 14h4" />
    </Svg>
  );
}

export function ReportsIcon() {
  return (
    <Svg>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M21 20H3" />
    </Svg>
  );
}

export function MoreIcon() {
  return (
    <Svg>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </Svg>
  );
}

export function CashIcon() {
  return (
    <Svg>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 9.5v5M18 9.5v5" />
    </Svg>
  );
}

export function CardIcon() {
  return (
    <Svg>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 15h3" />
    </Svg>
  );
}

export function BankIcon() {
  return (
    <Svg>
      <path d="M12 3 3.5 7.5h17L12 3Z" />
      <path d="M5.5 10.5v6M9.5 10.5v6M14.5 10.5v6M18.5 10.5v6" />
      <path d="M3.5 20.5h17" />
    </Svg>
  );
}

export function StoreIcon() {
  return (
    <Svg>
      <path d="M4 9.5 6 4h12l2 5.5" />
      <path d="M5 9.5V20h14V9.5" />
      <path d="M9 20v-5h6v5" />
    </Svg>
  );
}

export function UsersIcon() {
  return (
    <Svg>
      <circle cx="9" cy="8" r="2.5" />
      <path d="M4 19c.8-2.8 2.4-4.2 5-4.2s4.2 1.4 5 4.2" />
      <path d="M16 6.2a2.5 2.5 0 0 1 0 4.8M17 15c1.8.5 2.8 1.8 3 3.5" />
    </Svg>
  );
}

export function PrinterIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M7 8V4h10v4" />
      <path d="M6 8h12a2 2 0 0 1 2 2v6h-3v4H7v-4H4v-6a2 2 0 0 1 2-2Z" />
      <path d="M7 16h10M8 12h1" />
    </Svg>
  );
}

export function TagIcon() {
  return (
    <Svg>
      <path d="M4 4h7l9 9-7 7-9-9V4Z" />
      <circle cx="8" cy="8" r="1.2" />
    </Svg>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m5 12.5 4.5 4.5L19 7" />
    </Svg>
  );
}

export function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v5h-5" />
    </Svg>
  );
}

export function GlobeIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="8" />
      <path d="M4.5 9.5h15M4.5 14.5h15M12 4c2 2.2 3 4.9 3 8s-1 5.8-3 8c-2-2.2-3-4.9-3-8s1-5.8 3-8Z" />
    </Svg>
  );
}

export function CloudIcon() {
  return (
    <Svg>
      <path d="M7 18h10a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-9.6-1.4A3.8 3.8 0 0 0 7 18Z" />
    </Svg>
  );
}

export function DeviceIcon() {
  return (
    <Svg>
      <rect x="3" y="5" width="18" height="11" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </Svg>
  );
}

export function InfoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8h.01" />
    </Svg>
  );
}

export function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <path d="M12 14v2" />
    </Svg>
  );
}

export function UploadIcon() {
  return (
    <Svg>
      <path d="M12 16V4" />
      <path d="m8 8 4-4 4 4" />
      <path d="M4 15v4h16v-4" />
    </Svg>
  );
}

export function UserIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 20c.8-3.4 3-5.1 6.5-5.1s5.7 1.7 6.5 5.1" />
    </Svg>
  );
}
