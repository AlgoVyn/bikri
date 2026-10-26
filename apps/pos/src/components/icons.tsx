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

export function UdhaarIcon() {
  return (
    <Svg>
      <circle cx="12" cy="8" r="3" />
      <path d="M5.5 19.5c1.2-3 3.4-4.5 6.5-4.5s5.3 1.5 6.5 4.5" />
    </Svg>
  );
}

export function SettingsIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3V20.5M4.8 7.2l1.6 1.6M17.6 15.2l1.6 1.6M3.5 12h2.2M18.3 12H20.5M4.8 16.8l1.6-1.6M17.6 8.8l1.6-1.6" />
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

export function SearchIcon() {
  return (
    <Svg>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5 20 20" />
    </Svg>
  );
}
