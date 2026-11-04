/**
 * A row of chips or tabs. It wraps on desktop and becomes a horizontal strip on
 * phones, so seven date chips or seven tabs never eat three rows of the screen.
 */
export const scrollStrip =
  'scroll-strip flex flex-wrap gap-1 max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:px-3 max-lg:pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 max-lg:[mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]';
