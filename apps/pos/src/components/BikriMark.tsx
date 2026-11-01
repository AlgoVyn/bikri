/** The Bikri mark: a receipt with a B notch. Decorative beside the wordmark. */
export function BikriMark({ className = 'size-5' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <path
        d="M5 3h14v18l-2.8-1.8L13.4 21 12 19.6 10.6 21 7.8 19.2 5 21V3Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M9 7h4.2a2.4 2.4 0 0 1 0 4.8H9V7Zm0 4.8h4.8a2.4 2.4 0 0 1 0 4.8H9v-4.8Z"
        fill="currentColor"
      />
    </svg>
  );
}
