import { create } from 'zustand';

type GlobalSearchState = {
  open: boolean;
  openSearch: () => void;
  closeSearch: () => void;
};

/** One global search overlay, opened from the rail on desktop and the top bar on phones. */
export const useGlobalSearch = create<GlobalSearchState>((set) => ({
  open: false,
  openSearch: () => set({ open: true }),
  closeSearch: () => set({ open: false }),
}));
