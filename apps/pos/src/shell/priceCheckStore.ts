import { create } from 'zustand';

type PriceCheckState = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

/** Price check modal (screens/18): opened by Ctrl+Shift+P or the command palette. */
export const usePriceCheck = create<PriceCheckState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
