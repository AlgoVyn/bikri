import { create } from 'zustand';
import type { CartId } from '../data/cart.ts';

type SellState = {
  active: CartId;
  setActive: (id: CartId) => void;
};

/** The cart tab in front; in memory (carts themselves live in Dexie). */
export const useSellStore = create<SellState>((set) => ({
  active: 'c1',
  setActive: (active) => set({ active }),
}));
