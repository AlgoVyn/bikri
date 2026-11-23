import type { PrinterKv } from '../data/receipt.ts';
import { type AgentHealth, agentCompatible } from '../print/agent.ts';

/** A successful agent pairing is kept here until Save so cancelling or reloading cannot orphan it. */
export const AGENT_PENDING_KEY = 'printer_agent_pending';

export type SerialChoice = {
  baudRate: number;
  flowControl: 'none' | 'hardware';
};

/** The baud/flow controls keep their draft even before a port is chosen. */
export function serialChoiceOf(draft: PrinterKv): SerialChoice {
  return {
    baudRate: draft.serial?.baudRate ?? 9600,
    flowControl: draft.serial?.flowControl ?? 'none',
  };
}

/**
 * Applies a baud/flow choice. `draft.serial` is only created by a real
 * `requestPort()` (or a saved printer), so a baud change alone must not make
 * the wizard believe a port is selected.
 */
export function withSerialChoice(
  draft: PrinterKv,
  choice: SerialChoice,
): PrinterKv {
  return draft.serial
    ? { ...draft, serial: { ...draft.serial, ...choice } }
    : draft;
}

/** Whether Next/Save may proceed: the chosen transport has a usable device. */
export function printerConnected(
  draft: PrinterKv,
  health: AgentHealth | null,
): boolean {
  switch (draft.transport) {
    case 'system':
      return true;
    case 'usb':
      return Boolean(draft.usb);
    case 'serial':
      return Boolean(draft.serial);
    case 'agent':
      return Boolean(
        draft.agent?.token &&
          draft.agent.printerName &&
          agentCompatible(health),
      );
    default:
      return false;
  }
}
