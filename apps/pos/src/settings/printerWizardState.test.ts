import { describe, expect, it } from 'vitest';
import type { PrinterKv } from '../data/receipt.ts';
import type { AgentHealth } from '../print/agent.ts';
import {
  printerConnected,
  type SerialChoice,
  serialChoiceOf,
  withSerialChoice,
} from './printerWizardState.ts';

const healthy: AgentHealth = {
  app: 'bikri-print-agent',
  version: '0.1.9',
  protocol: 1,
  platform: 'linux/amd64',
  paired: true,
  printers: 1,
};

const agent = {
  url: 'http://127.0.0.1:17890',
  token: 'token',
  agentId: 'agent-1',
  printerName: 'Bixolon',
  mode: 'raw' as const,
};

describe('printer wizard state', () => {
  it('does not treat a baud-rate draft as a selected serial port', () => {
    const draft: PrinterKv = { transport: 'serial' };
    expect(printerConnected(draft, null)).toBe(false);
    const chosen: SerialChoice = { baudRate: 19200, flowControl: 'none' };
    // Before requestPort() there is no `serial` object to update.
    expect(withSerialChoice(draft, chosen)).toEqual(draft);
    expect(printerConnected(withSerialChoice(draft, chosen), null)).toBe(false);
    const portChosen: PrinterKv = {
      transport: 'serial',
      serial: { baudRate: 9600, flowControl: 'none' },
    };
    expect(withSerialChoice(portChosen, chosen)).toEqual({
      transport: 'serial',
      serial: { baudRate: 19200, flowControl: 'none' },
    });
    expect(printerConnected(withSerialChoice(portChosen, chosen), null)).toBe(
      true,
    );
  });

  it('reads saved serial baud and flow control as the control defaults', () => {
    expect(serialChoiceOf({})).toEqual({
      baudRate: 9600,
      flowControl: 'none',
    });
    expect(
      serialChoiceOf({
        serial: { baudRate: 115200, flowControl: 'hardware' },
      }),
    ).toEqual({ baudRate: 115200, flowControl: 'hardware' });
  });

  it('gates agent save on the protocol, minimum version and a chosen printer', () => {
    const draft: PrinterKv = { transport: 'agent', agent };
    expect(printerConnected(draft, healthy)).toBe(true);
    expect(printerConnected(draft, { ...healthy, version: '0.1.8' })).toBe(
      false,
    );
    expect(printerConnected(draft, { ...healthy, protocol: 2 })).toBe(false);
    expect(printerConnected(draft, { ...healthy, paired: false })).toBe(false);
    expect(printerConnected(draft, null)).toBe(false);
    expect(
      printerConnected(
        { transport: 'agent', agent: { ...agent, printerName: '' } },
        healthy,
      ),
    ).toBe(false);
    expect(
      printerConnected(
        { transport: 'agent', agent: { ...agent, token: '' } },
        healthy,
      ),
    ).toBe(false);
  });

  it('keeps USB and system gating', () => {
    expect(printerConnected({ transport: 'system' }, null)).toBe(true);
    expect(printerConnected({ transport: 'usb' }, null)).toBe(false);
    expect(
      printerConnected(
        { transport: 'usb', usb: { vendorId: 1, productId: 2 } },
        null,
      ),
    ).toBe(true);
    expect(printerConnected({}, null)).toBe(false);
  });
});
