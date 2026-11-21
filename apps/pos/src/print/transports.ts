/**
 * Printer transports (06 §5): WebUSB and Web Serial send ESC/POS bytes; system printing is in
 * systemPrint.ts. Only the parts of the browser APIs Bikri uses are typed here (no extra deps).
 */

export type PrintErrorCode =
  | 'NO_PRINTER'
  | 'PERMISSION'
  | 'AGENT_AUTH'
  | 'DISCONNECTED'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'PAPER_OUT'
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
/**
 * Bound for cleaning up a wedged transport. A stuck USB IRP or serial close must
 * not keep `processQueue` from moving to the next job.
 */
export const CLEANUP_TIMEOUT_MS = 1500;

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
  close(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
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
  close(): Promise<void>;
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

/**
 * Like withTimeout, but runs a cleanup (abort/close) when the deadline wins so a
 * stuck WebUSB/Web Serial write cannot keep the interface or writer locked.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Promise<void> | void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        void Promise.resolve(onTimeout()).catch(() => undefined);
      } catch {
        // Cleanup is best-effort; the TIMEOUT error still reaches the caller.
      }
      reject(new PrintError('TIMEOUT'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
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

const claimed = new WeakMap<
  UsbDeviceLike,
  { iface: number; endpoint: number }
>();

async function releaseUsb(
  device: UsbDeviceLike,
  state: { iface: number } | undefined,
  cleanupMs: number,
): Promise<void> {
  claimed.delete(device);
  if (state) {
    try {
      // releaseInterface/close can hang on a wedged IRP; a failed print must not
      // block the queue until the tab is reloaded.
      await withTimeout(device.releaseInterface(state.iface), cleanupMs);
    } catch {
      // Already disconnected; close below is still best-effort.
    }
  }
  try {
    await withTimeout(device.close(), cleanupMs);
  } catch {
    // The device may already be gone, or the driver never answered.
  }
}

export async function sendUsb(
  device: UsbDeviceLike,
  bytes: Uint8Array,
  ms = JOB_TIMEOUT_MS,
  cleanupMs = CLEANUP_TIMEOUT_MS,
): Promise<void> {
  // One deadline for open + claim + every chunk. Giving each chunk a fresh `ms`
  // let a slow printer stretch one job to minutes.
  const deadline = Date.now() + ms;
  let state = claimed.get(device);
  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= releaseUsb(device, state, cleanupMs);
    return cleanupPromise;
  };
  const timed = <T>(promise: Promise<T>): Promise<T> => {
    const left = deadline - Date.now();
    if (left <= 0) {
      void cleanup();
      return Promise.reject(new PrintError('TIMEOUT'));
    }
    return withDeadline(promise, left, cleanup);
  };
  try {
    if (!state || !device.opened) {
      state = undefined;
      claimed.delete(device);
      if (!device.opened) await timed(device.open());
      if (device.configuration === null)
        await timed(device.selectConfiguration(1));
      const target = printerEndpoint(device);
      if (!target) throw new PrintError('UNSUPPORTED');
      try {
        await timed(device.claimInterface(target.iface));
      } catch (err) {
        // Windows vendor driver or Linux usblp owns the device (06 §5.1).
        const name = (err as { name?: string } | null)?.name;
        if (name === 'SecurityError' || name === 'NetworkError')
          throw new PrintError('PERMISSION');
        throw err;
      }
      state = { iface: target.iface, endpoint: target.endpoint };
      claimed.set(device, state);
    }
    for (const chunk of chunks(bytes)) {
      // A stuck transferOut otherwise leaves the interface claimed forever.
      const result = await timed(
        device.transferOut(state.endpoint, chunk as BufferSource),
      );
      if (result.status !== 'ok') throw new PrintError('FAILED', result.status);
    }
  } catch (err) {
    await cleanup();
    throw mapError(err);
  }
}

type SerialOptions = Pick<SerialSaved, 'baudRate' | 'flowControl'>;

/** Options the port was opened with; a settings change closes and reopens it. */
const serialOpen = new WeakMap<SerialPortLike, SerialOptions>();

async function closeSerial(
  port: SerialPortLike,
  closeMs = CLEANUP_TIMEOUT_MS,
): Promise<void> {
  serialOpen.delete(port);
  try {
    // A wedged driver must not hang the print queue; the promise is abandoned.
    await withTimeout(port.close(), closeMs);
  } catch {
    // Already closed, never opened, or the driver did not answer.
  }
}

export async function sendSerial(
  port: SerialPortLike,
  bytes: Uint8Array,
  options: SerialOptions,
  ms = JOB_TIMEOUT_MS,
  cleanupMs = CLEANUP_TIMEOUT_MS,
): Promise<void> {
  // A raw receipt can be several KB; at 9600 baud that takes longer than the
  // fixed job timeout. Allow the wire time plus one second of device overhead.
  const baudRate = options.baudRate > 0 ? options.baudRate : 9600;
  const wireMs = Math.ceil((bytes.length * 10 * 1000) / baudRate);
  const timeoutMs = Math.max(ms, wireMs + 1000);
  const current = serialOpen.get(port);
  if (
    port.writable &&
    (!current ||
      current.baudRate !== options.baudRate ||
      current.flowControl !== options.flowControl)
  )
    await closeSerial(port, cleanupMs);
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  /**
   * One cleanup path, in the order the Streams API requires: abort the transfer,
   * release the writer lock, then close the port. Calling `close()` while the
   * writer still holds the lock rejects with "Cannot cancel a locked stream",
   * which the old code swallowed after forgetting the port — leaving the
   * physical serial port open.
   */
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      serialOpen.delete(port);
      const held = writer;
      writer = null;
      try {
        await held?.abort();
      } catch {
        // The stream may already be errored.
      }
      try {
        held?.releaseLock();
      } catch {
        // abort() already released it in some browsers.
      }
      try {
        await withTimeout(port.close(), cleanupMs);
      } catch {
        // Already closed, or the driver never answered.
      }
    })();
    return cleanupPromise;
  };
  try {
    if (!port.writable) {
      // A wedged COM/USB-serial port used to hang processQueue permanently.
      await withDeadline(
        port.open({
          baudRate: options.baudRate,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          flowControl: options.flowControl,
        }),
        timeoutMs,
        cleanup,
      );
      serialOpen.set(port, {
        baudRate: options.baudRate,
        flowControl: options.flowControl,
      });
    }
    if (!port.writable) throw new PrintError('DISCONNECTED');
    writer = port.writable.getWriter();
    // A timed-out write would otherwise keep the WritableStream locked until reload.
    await withDeadline(writer.write(bytes), timeoutMs, cleanup);
    // The port stays open for the next receipt; release only the writer lock.
    writer.releaseLock();
    writer = null;
  } catch (err) {
    await cleanup();
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
