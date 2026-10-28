import { create } from 'zustand';

type PriceCheckState = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

/** Price check modal (screens/18): opened from Home, the rail or Ctrl+Shift+P anywhere. */
export const usePriceCheck = create<PriceCheckState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
