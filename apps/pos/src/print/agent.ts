/**
 * Client for the Bikri Print Agent (docs/14-print-agent.md). The agent runs on
 * loopback and prints through the OS queue; this module never talks to a LAN
 * printer directly.
 */

export const AGENT_URL = 'http://127.0.0.1:17890';
/** Update this tag when publishing a new print-agent release. */
export const AGENT_RELEASE_TAG = 'print-agent-v0.1.0';
export const AGENT_RELEASE_URL = `https://github.com/AlgoVyn/bikri/releases/tag/${AGENT_RELEASE_TAG}`;
const releaseAsset = (name: string) =>
  `https://github.com/AlgoVyn/bikri/releases/download/${AGENT_RELEASE_TAG}/${name}`;

/** Platform archives, linked directly from the wizard. */
export const AGENT_DOWNLOADS = {
  windows: releaseAsset('bikri-print-agent-windows-amd64.zip'),
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

const HEALTH_TIMEOUT_MS = 1200;
const REQUEST_TIMEOUT_MS = 15000;
const STATUS_TIMEOUT_MS = 3000;

function base(url: string): string {
  return url.replace(/\/+$/u, '');
}

async function request<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new AgentRequestError(
      'UNAVAILABLE',
      err instanceof Error ? err.message : 'print service is not reachable',
    );
  } finally {
    clearTimeout(timer);
  }
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
  return body as T;
}

function headers(token?: string, json = false): Record<string, string> {
  const out: Record<string, string> = {};
  if (json) out['Content-Type'] = 'application/json';
  if (token) out.Authorization = `Bearer ${token}`;
  return out;
}

/** The real loopback client. Tests can inject a fake AgentClient instead. */
export const httpAgentClient: AgentClient = {
  health(url = AGENT_URL) {
    return request<AgentHealth>(
      `${base(url)}/v1/health`,
      {},
      HEALTH_TIMEOUT_MS,
    );
  },
  pair(url, code, clientName = 'Bikri') {
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
  printers(url, token) {
    return request<AgentPrinter[]>(
      `${base(url)}/v1/printers`,
      { headers: headers(token) },
      REQUEST_TIMEOUT_MS,
    );
  },
  print(url, token, body) {
    return request<AgentJob>(
      `${base(url)}/v1/jobs`,
      {
        method: 'POST',
        headers: headers(token, true),
        body: JSON.stringify(body),
      },
      REQUEST_TIMEOUT_MS,
    );
  },
  job(url, token, id) {
    return request<AgentJob>(
      `${base(url)}/v1/jobs/${encodeURIComponent(id)}`,
      { headers: headers(token) },
      STATUS_TIMEOUT_MS,
    );
  },
  cancel(url, token, id) {
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
    );
  },
  diagnostics(url, token) {
    return request<unknown>(
      `${base(url)}/v1/diagnostics`,
      { headers: headers(token) },
      REQUEST_TIMEOUT_MS,
    );
  },
};
