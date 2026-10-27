/**
 * Printer transports (06 §5): WebUSB and Web Serial send ESC/POS bytes; system printing is in
 * systemPrint.ts. Only the parts of the browser APIs Bikri uses are typed here (no extra deps).
 */

export type PrintErrorCode =
  | 'NO_PRINTER'
  | 'PERMISSION'
  | 'DISCONNECTED'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'FAILED';

export class PrintError extends Error {
  readonly code: PrintErrorCode;
  constructor(code: PrintErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PrintError';
    this.code = code;
  }
}

export const USB_CHUNK = 4096;
export const JOB_TIMEOUT_MS = 8000;

// --- minimal WebUSB / Web Serial shapes ---
export type UsbEndpointLike = {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: string;
};
export type UsbInterfaceLike = {
  interfaceNumber: number;
  alternates: { interfaceClass: number; endpoints: UsbEndpointLike[] }[];
};
export type UsbDeviceLike = {
  vendorId: number;
  productId: number;
  serialNumber?: string | null;
  productName?: string | null;
  opened: boolean;
  configuration: { interfaces: UsbInterfaceLike[] } | null;
  open(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(
    endpoint: number,
    data: BufferSource,
  ): Promise<{ status: string }>;
  forget?(): Promise<void>;
};
export type UsbLike = {
  requestDevice(options: {
    filters: { classCode?: number }[];
  }): Promise<UsbDeviceLike>;
  getDevices(): Promise<UsbDeviceLike[]>;
};
export type SerialPortLike = {
  readable: unknown;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  open(options: {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: string;
    flowControl?: string;
  }): Promise<void>;
  forget?(): Promise<void>;
};
export type SerialLike = {
  requestPort(): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
};

export type UsbSaved = {
  vendorId: number;
  productId: number;
  serialNumber?: string | null;
};
export type SerialSaved = {
  usbVendorId?: number;
  usbProductId?: number;
  baudRate: number;
  flowControl: 'none' | 'hardware';
};

export function webUsb(nav: Navigator = navigator): UsbLike | null {
  return ((nav as unknown as { usb?: UsbLike }).usb ?? null) as UsbLike | null;
}
export function webSerial(nav: Navigator = navigator): SerialLike | null {
  return ((nav as unknown as { serial?: SerialLike }).serial ??
    null) as SerialLike | null;
}

/** Rejects with TIMEOUT if the promise does not settle in time. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms = JOB_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PrintError('TIMEOUT')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function chunks(bytes: Uint8Array, size = USB_CHUNK): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size)
    out.push(bytes.subarray(i, i + size));
  return out;
}

function mapError(err: unknown): PrintError {
  if (err instanceof PrintError) return err;
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'SecurityError' || name === 'NotAllowedError')
    return new PrintError('PERMISSION');
  if (
    name === 'NotFoundError' ||
    name === 'NetworkError' ||
    name === 'InvalidStateError'
  )
    return new PrintError('DISCONNECTED');
  return new PrintError('FAILED', (err as Error)?.message);
}

/** Interface with a bulk OUT endpoint, printer class (7) first (06 §5.1). */
function printerEndpoint(
  device: UsbDeviceLike,
): { iface: number; endpoint: number } | null {
  const ifaces = device.configuration?.interfaces ?? [];
  const withOut = ifaces
    .map((i) => ({
      i,
      alt: i.alternates[0],
      ep: i.alternates[0]?.endpoints.find(
        (e) => e.direction === 'out' && e.type === 'bulk',
      ),
    }))
    .filter((x) => x.ep);
  const pick = withOut.find((x) => x.alt?.interfaceClass === 7) ?? withOut[0];
  return pick?.ep
    ? { iface: pick.i.interfaceNumber, endpoint: pick.ep.endpointNumber }
    : null;
}

const claimed = new WeakMap<UsbDeviceLike, { endpoint: number }>();

export async function sendUsb(
  device: UsbDeviceLike,
  bytes: Uint8Array,
): Promise<void> {
  try {
    let state = claimed.get(device);
    if (!state || !device.opened) {
      if (!device.opened) await device.open();
      if (device.configuration === null) await device.selectConfiguration(1);
      const target = printerEndpoint(device);
      if (!target) throw new PrintError('UNSUPPORTED');
      try {
        await device.claimInterface(target.iface);
      } catch (err) {
        // Windows vendor driver or Linux usblp owns the device (06 §5.1).
        const name = (err as { name?: string } | null)?.name;
        if (name === 'SecurityError' || name === 'NetworkError')
          throw new PrintError('PERMISSION');
        throw err;
      }
      state = { endpoint: target.endpoint };
      claimed.set(device, state);
    }
    for (const chunk of chunks(bytes)) {
      const result = await device.transferOut(
        state.endpoint,
        chunk as BufferSource,
      );
      if (result.status !== 'ok') throw new PrintError('FAILED', result.status);
    }
  } catch (err) {
    claimed.delete(device);
    throw mapError(err);
  }
}

export async function sendSerial(
  port: SerialPortLike,
  bytes: Uint8Array,
  options: Pick<SerialSaved, 'baudRate' | 'flowControl'>,
): Promise<void> {
  try {
    if (!port.writable)
      await port.open({
        baudRate: options.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: options.flowControl,
      });
    if (!port.writable) throw new PrintError('DISCONNECTED');
    const writer = port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  } catch (err) {
    throw mapError(err);
  }
}

/** The saved printer among already-granted devices (no prompt, 06 §5.1). */
export async function findUsb(
  usb: UsbLike | null,
  saved: UsbSaved | undefined,
) {
  if (!usb || !saved) return null;
  const devices = await usb.getDevices();
  return (
    devices.find(
      (d) =>
        d.vendorId === saved.vendorId &&
        d.productId === saved.productId &&
        (saved.serialNumber == null || d.serialNumber === saved.serialNumber),
    ) ?? null
  );
}

export async function findSerial(
  serial: SerialLike | null,
  saved: SerialSaved | undefined,
) {
  if (!serial || !saved) return null;
  const ports = await serial.getPorts();
  return (
    ports.find((p) => {
      const info = p.getInfo();
      return (
        saved.usbVendorId === undefined ||
        (info.usbVendorId === saved.usbVendorId &&
          info.usbProductId === saved.usbProductId)
      );
    }) ?? null
  );
}
