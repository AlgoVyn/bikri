/** Fake WebUSB / Web Serial printers for unit tests (record what was sent). */
import type {
  SerialLike,
  SerialPortLike,
  UsbDeviceLike,
  UsbLike,
} from './transports.ts';

export type FakeUsb = UsbLike & {
  device: UsbDeviceLike & {
    sent: Uint8Array[];
    fail?: string;
    claimFail?: string;
    hang?: boolean;
  };
};

export function fakeUsb(
  options: { interfaceClass?: number; serialNumber?: string } = {},
): FakeUsb {
  const device: FakeUsb['device'] = {
    vendorId: 0x0416,
    productId: 0x5011,
    serialNumber: options.serialNumber ?? 'P1',
    productName: 'POS-80',
    opened: false,
    configuration: null,
    sent: [],
    async open() {
      device.opened = true;
    },
    async selectConfiguration() {
      device.configuration = {
        interfaces: [
          {
            interfaceNumber: 0,
            alternates: [
              {
                interfaceClass: 3,
                endpoints: [
                  { endpointNumber: 9, direction: 'in', type: 'interrupt' },
                ],
              },
            ],
          },
          {
            interfaceNumber: 1,
            alternates: [
              {
                interfaceClass: options.interfaceClass ?? 7,
                endpoints: [
                  { endpointNumber: 1, direction: 'in', type: 'bulk' },
                  { endpointNumber: 2, direction: 'out', type: 'bulk' },
                ],
              },
            ],
          },
        ],
      };
    },
    async claimInterface() {
      if (device.claimFail)
        throw Object.assign(new Error('claim'), { name: device.claimFail });
    },
    async transferOut(endpoint, data) {
      if (device.hang) return new Promise(() => undefined);
      if (device.fail)
        throw Object.assign(new Error('gone'), { name: device.fail });
      if (endpoint !== 2) throw new Error('wrong endpoint');
      device.sent.push(new Uint8Array(data as unknown as Uint8Array));
      return { status: 'ok' };
    },
  };
  return {
    device,
    async requestDevice() {
      return device;
    },
    async getDevices() {
      return [device];
    },
  };
}

export type FakeSerial = SerialLike & {
  port: SerialPortLike & { sent: Uint8Array[]; openedWith?: unknown };
};

export function fakeSerial(): FakeSerial {
  const sent: Uint8Array[] = [];
  const port: FakeSerial['port'] = {
    sent,
    readable: null,
    writable: null,
    getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    async open(o) {
      port.openedWith = o;
      port.writable = {
        getWriter: () => ({
          write: async (b: Uint8Array) => {
            sent.push(new Uint8Array(b));
          },
          releaseLock: () => undefined,
        }),
      } as unknown as WritableStream<Uint8Array>;
    },
  };
  return {
    port,
    async requestPort() {
      return port;
    },
    async getPorts() {
      return [port];
    },
  };
}

export const joined = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
