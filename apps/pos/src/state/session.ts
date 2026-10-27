import { create } from 'zustand';

/** Unlocked staff (05 §4): kept in memory only, never persisted. */
export type Session = {
  staff_id: string;
  role: 'owner' | 'manager' | 'cashier';
  unlocked_at: number;
};

type SessionState = {
  session: Session | null;
  /** Set by the setup wizard's Finish so Home shows "Your shop is ready" once. */
  justSetUp: boolean;
  /** Where the wizard's Finish goes ('/products/import' for "Import a spreadsheet"). */
  afterSetup: '/' | '/products/import';
  unlock: (session: Session) => void;
  lock: () => void;
  setJustSetUp: (value: boolean) => void;
  setAfterSetup: (path: '/' | '/products/import') => void;
};

export const useSession = create<SessionState>((set) => ({
  session: null,
  justSetUp: false,
  afterSetup: '/',
  setJustSetUp: (justSetUp) => set({ justSetUp }),
  setAfterSetup: (afterSetup) => set({ afterSetup }),
  unlock: (session) => set({ session }),
  lock: () => set({ session: null }),
}));
