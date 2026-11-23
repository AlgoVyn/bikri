/**
 * Client for the Bikri Print Agent (docs/14-print-agent.md). The agent runs on
 * loopback and prints through the OS queue; this module never talks to a LAN
 * printer directly.
 */

export const AGENT_URL = 'http://127.0.0.1:17890';
/** The only agent API version this PWA speaks (docs/14-print-agent.md §6). */
export const AGENT_PROTOCOL = 1;
/** Older agents are reported in the wizard and cannot be saved (docs/14 §6). */
export const AGENT_MIN_VERSION = '0.1.9';
/** Update this tag when publishing a new print-agent release. */
export const AGENT_RELEASE_TAG = 'print-agent-v0.1.9';
export const AGENT_RELEASE_URL = `https://github.com/AlgoVyn/bikri/releases/tag/${AGENT_RELEASE_TAG}`;
const releaseAsset = (name: string) =>
  `https://github.com/AlgoVyn/bikri/releases/download/${AGENT_RELEASE_TAG}/${name}`;

/** Platform archives, linked directly from the wizard. */
export const AGENT_DOWNLOADS = {
  windows: releaseAsset('bikri-print-agent-setup.exe'),
  linux: releaseAsset('bikri-print-agent-linux-amd64.tar.gz'),
  linuxArm: releaseAsset('bikri-print-agent-linux-arm64.tar.gz'),
  macos: releaseAsset('bikri-print-agent-darwin-amd64.tar.gz'),
  macosArm: releaseAsset('bikri-print-agent-darwin-arm64.tar.gz'),
} as const;
export const AGENT_SHA256_URL = releaseAsset('SHA256SUMS');
export type AgentDownloadKey = keyof typeof AGENT_DOWNLOADS;
export type AgentPlatform = 'windows' | 'linux' | 'macos' | null;

/** Best-effort platform for choosing the primary download; never used for security. */
export function agentPlatform(
  ua = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): AgentPlatform {
  if (/Windows/iu.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/iu.test(ua)) return 'macos';
  if (/Linux|X11/iu.test(ua)) return 'linux';
  return null;
}

export type AgentMode = 'raw' | 'driver';
export type AgentJobState =
  | 'received'
  | 'queued'
  | 'spooled'
  | 'printing'
  | 'done'
  | 'failed'
  | 'canceled';

export type AgentHealth = {
  app: string;
  version: string;
  protocol: number;
  platform: string;
  paired: boolean;
  printers: number;
  /** Present only while unpaired; short-lived, shown inside Bikri. */
  pairingCode?: string;
};

export type AgentPrinter = {
  name: string;
  driver?: string;
  port?: string;
  isDefault: boolean;
  supportsRaw?: boolean;
};

export type AgentPrintRequest = {
  jobId: string;
  printer: string;
  mode: AgentMode;
  paperMm: 58 | 80;
  /** Raw: ESC/POS print-area dots. Driver: PNG canvas width in dots. */
  widthDots?: number;
  copies?: number;
  encoding: 'escpos' | 'png';
  /** Base64; no data-URL prefix. */
  data: string;
};

export type AgentJob = {
  jobId: string;
  status: AgentJobState;
  error?: string;
  detail?: string;
  printer?: string;
  mode?: string;
  createdAt: number;
  updatedAt: number;
};

export type AgentConfig = {
  url: string;
  token: string;
  agentId: string;
  printerName: string;
  mode: AgentMode;
};

export type AgentClient = {
  health(url?: string): Promise<AgentHealth>;
  pair(
    url: string,
    code: string,
    clientName?: string,
  ): Promise<{ token: string; agentId: string }>;
  printers(url: string, token: string): Promise<AgentPrinter[]>;
  print(
    url: string,
    token: string,
    request: AgentPrintRequest,
  ): Promise<AgentJob>;
  job(url: string, token: string, id: string): Promise<AgentJob>;
  cancel(url: string, token: string, id: string): Promise<AgentJob>;
  unpair(url: string, token: string): Promise<void>;
  diagnostics(url: string, token: string): Promise<unknown>;
};

export class AgentRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'AgentRequestError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The agent only ever runs on this machine (docs/14 §6), so a bearer token or a
 * receipt must never leave for another origin — even if a stored `kv.printer`
 * was edited or migrated from another deployment.
 */
export class AgentUrlError extends Error {
  readonly code = 'INSECURE_URL';
  constructor(url: string) {
    super(`print service URL must be loopback http, not ${url}`);
    this.name = 'AgentUrlError';
  }
}

/**
 * Accepts exactly `http://127.0.0.1:<port>` or `http://localhost:<port>` and
 * returns that origin (no path, credentials, query or fragment).
 */
export function loopbackBase(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AgentUrlError(url);
  }
  if (
    parsed.protocol !== 'http:' ||
    (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  )
    throw new AgentUrlError(url);
  return parsed.origin;
}

/** Numeric `major.minor.patch`; a suffix (`0.1.9-test`) still compares by numbers. */
function versionParts(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `version` is at least `minimum` (`major.minor.patch`). */
export function agentVersionAtLeast(
  version: string,
  minimum = AGENT_MIN_VERSION,
): boolean {
  const current = versionParts(version);
  const floor = versionParts(minimum);
  if (!current || !floor) return false;
  for (let index = 0; index < 3; index += 1) {
    const left = current[index] ?? 0;
    const right = floor[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/** Protocol and minimum version this PWA needs before pairing or saving (docs/14 §6). */
export function agentCompatible(health: AgentHealth | null): boolean {
  return (
    health !== null &&
    health.protocol === AGENT_PROTOCOL &&
    agentVersionAtLeast(health.version)
  );
}

const HEALTH_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;
// The agent allows a spooler up to 30 s for POST /v1/jobs; aborting at 15 s
// made a slow but healthy queue look like DISCONNECTED.
const PRINT_TIMEOUT_MS = 35_000;
const STATUS_TIMEOUT_MS = 3000;

function base(url: string): string {
  return loopbackBase(url);
}

async function request<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  options: { expectJson?: boolean } = {},
): Promise<T> {
  const expectJson = options.expectJson ?? true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Reading the body belongs to the request: a stalled body used to outlive
    // the timeout and hang the caller forever.
    const text = await response.text();
    let body: unknown = null;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      const record =
        body !== null && typeof body === 'object'
          ? (body as Record<string, unknown>)
          : {};
      const code =
        typeof record.error === 'string'
          ? record.error
          : `HTTP_${response.status}`;
      const message =
        typeof record.message === 'string'
          ? record.message
          : `print service responded ${response.status}`;
      throw new AgentRequestError(code, message, response.status);
    }
    if (expectJson && (body === null || typeof body !== 'object')) {
      // A 200 with a broken body used to return `null as T`, blowing up later
      // with a TypeError instead of a print error the UI can show.
      throw new AgentRequestError(
        'BAD_RESPONSE',
        'the print service returned an invalid response',
        response.status,
      );
    }
    return body as T;
  } catch (err) {
    if (err instanceof AgentRequestError) throw err;
    if (controller.signal.aborted) {
      // Our own deadline, not an unreachable agent: the queue maps TIMEOUT to a
      // retryable state instead of DISCONNECTED + "install the agent".
      throw new AgentRequestError(
        'TIMEOUT',
        'the print service did not answer in time',
      );
    }
    throw new AgentRequestError(
      'UNAVAILABLE',
      err instanceof Error ? err.message : 'print service is not reachable',
    );
  } finally {
    clearTimeout(timer);
  }
}

function headers(token?: string, json = false): Record<string, string> {
  const out: Record<string, string> = {};
  if (json) out['Content-Type'] = 'application/json';
  if (token) out.Authorization = `Bearer ${token}`;
  return out;
}

/** The real loopback client. Tests can inject a fake AgentClient instead. */
export const httpAgentClient: AgentClient = {
  async health(url = AGENT_URL) {
    return request<AgentHealth>(
      `${base(url)}/v1/health`,
      {},
      HEALTH_TIMEOUT_MS,
    );
  },
  async pair(url, code, clientName = 'Bikri') {
    return request<{ token: string; agentId: string }>(
      `${base(url)}/v1/pair`,
      {
        method: 'POST',
        headers: headers(undefined, true),
        body: JSON.stringify({ code, clientName }),
      },
      REQUEST_TIMEOUT_MS,
    );
  },
  async printers(url, token) {
    return request<AgentPrinter[]>(
      `${base(url)}/v1/printers`,
      { headers: headers(token) },
      REQUEST_TIMEOUT_MS,
    );
  },
  async print(url, token, body) {
    return request<AgentJob>(
      `${base(url)}/v1/jobs`,
      {
        method: 'POST',
        headers: headers(token, true),
        body: JSON.stringify(body),
      },
      PRINT_TIMEOUT_MS,
    );
  },
  async job(url, token, id) {
    return request<AgentJob>(
      `${base(url)}/v1/jobs/${encodeURIComponent(id)}`,
      { headers: headers(token) },
      STATUS_TIMEOUT_MS,
    );
  },
  async cancel(url, token, id) {
    return request<AgentJob>(
      `${base(url)}/v1/jobs/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: headers(token) },
      STATUS_TIMEOUT_MS,
    );
  },
  async unpair(url, token) {
    await request<unknown>(
      `${base(url)}/v1/unpair`,
      { method: 'POST', headers: headers(token) },
      REQUEST_TIMEOUT_MS,
      { expectJson: false },
    );
  },
  async diagnostics(url, token) {
    return request<unknown>(
      `${base(url)}/v1/diagnostics`,
      { headers: headers(token) },
      REQUEST_TIMEOUT_MS,
    );
  },
};
