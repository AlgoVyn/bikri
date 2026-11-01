/**
 * A row of chips or tabs. It wraps on desktop and becomes a horizontal strip on
 * phones, so seven date chips or seven tabs never eat three rows of the screen.
 */
export const scrollStrip =
  'flex flex-wrap gap-1 max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0';
