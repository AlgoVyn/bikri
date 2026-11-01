/** One line-art shop/receipt illustration for first-run and empty-shop surfaces. */
export function ShopIllustration({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 110"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M18 96h164" opacity=".5" />
      <path d="M34 96V45h82v51" />
      <path d="M34 45 44 26h62l10 19" />
      <path d="M44 45v-8h62v8" />
      <rect x="51" y="58" width="21" height="21" rx="1" />
      <path d="M82 59h23M82 67h17M82 75h23" />
      <path d="M130 96V55h36v41" />
      <path d="M139 65h18M139 73h18M139 81h11" />
      <path d="M18 96 8 80h7l7 16M182 96l10-16h-7l-7 16" opacity=".5" />
    </svg>
  );
}
