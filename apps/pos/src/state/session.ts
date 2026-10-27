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
  unlock: (session: Session) => void;
  lock: () => void;
  setJustSetUp: (value: boolean) => void;
};

export const useSession = create<SessionState>((set) => ({
  session: null,
  justSetUp: false,
  setJustSetUp: (justSetUp) => set({ justSetUp }),
  unlock: (session) => set({ session }),
  lock: () => set({ session: null }),
}));
