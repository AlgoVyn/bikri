import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_MIN_VERSION,
  AgentUrlError,
  agentCompatible,
  agentVersionAtLeast,
  httpAgentClient,
  loopbackBase,
} from './agent.ts';

const abortError = () =>
  Object.assign(new Error('aborted'), { name: 'AbortError' });

/** fetch that never settles until the request's AbortSignal fires. */
function pendingFetch(): typeof fetch {
  return ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(abortError()));
    })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('http agent client (docs/14 §6)', () => {
  it('reports an unresponsive agent as TIMEOUT, not UNAVAILABLE', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', pendingFetch());
    const pending = httpAgentClient.health();
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'AgentRequestError',
      code: 'TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  it('keeps the timeout while the response body is being read', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      text: () =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(abortError()));
        }),
    })) as unknown as typeof fetch);
    const pending = httpAgentClient.health();
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  it('rejects a 200 with a broken body instead of returning null', async () => {
    vi.stubGlobal('fetch', (async () => ({
      ok: true,
      status: 200,
      text: async () => 'not json',
    })) as unknown as typeof fetch);
    await expect(httpAgentClient.health()).rejects.toMatchObject({
      name: 'AgentRequestError',
      code: 'BAD_RESPONSE',
    });
  });

  it('surfaces the agent error code and status', async () => {
    vi.stubGlobal('fetch', (async () => ({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({ error: 'UNAUTHORIZED', message: 'pair again' }),
    })) as unknown as typeof fetch);
    await expect(
      httpAgentClient.print('http://127.0.0.1:17890', 't', {
        jobId: 'job-1',
        printer: 'Bixolon',
        mode: 'raw',
        paperMm: 80,
        encoding: 'escpos',
        data: 'G0Bh',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('accepts the empty 204 body of an unpair', async () => {
    vi.stubGlobal('fetch', (async () => ({
      ok: true,
      status: 204,
      text: async () => '',
    })) as unknown as typeof fetch);
    await expect(
      httpAgentClient.unpair('http://127.0.0.1:17890', 't'),
    ).resolves.toBeUndefined();
  });
});

describe('agent loopback URL (PRT-M3)', () => {
  it('accepts exactly the loopback http origins', () => {
    expect(loopbackBase('http://127.0.0.1:17890')).toBe(
      'http://127.0.0.1:17890',
    );
    expect(loopbackBase('http://127.0.0.1:17890/')).toBe(
      'http://127.0.0.1:17890',
    );
    expect(loopbackBase('http://localhost:17890')).toBe(
      'http://localhost:17890',
    );
  });

  it('rejects every URL that could leak the token or receipt payload', () => {
    for (const url of [
      'https://127.0.0.1:17890',
      'http://192.168.1.5:17890',
      'http://evil.example:17890',
      'http://127.0.0.1.example.com:17890',
      'http://127.0.0.1:17890/v1',
      'http://127.0.0.1:17890?x=1',
      'http://user:pass@127.0.0.1:17890',
      'http://[::1]:17890',
      'not a url',
    ])
      expect(() => loopbackBase(url), url).toThrow(AgentUrlError);
  });

  it('never calls fetch for a non-loopback URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      httpAgentClient.print('https://evil.example', 'secret', {
        jobId: 'job-1',
        printer: 'Bixolon',
        mode: 'raw',
        paperMm: 80,
        encoding: 'escpos',
        data: 'G0Bh',
      }),
    ).rejects.toMatchObject({ name: 'AgentUrlError', code: 'INSECURE_URL' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalises a trailing slash before the API path', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          app: 'bikri-print-agent',
          version: '0.1.9',
          protocol: 1,
          platform: 'linux/amd64',
          paired: false,
          printers: 0,
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await httpAgentClient.health('http://localhost:17890/');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:17890/v1/health',
      expect.anything(),
    );
  });
});

describe('agent version gating (PRT-M2)', () => {
  it('compares major, minor and patch numerically', () => {
    expect(AGENT_MIN_VERSION).toBe('0.1.9');
    expect(agentVersionAtLeast('0.1.9')).toBe(true);
    expect(agentVersionAtLeast('0.1.10')).toBe(true);
    expect(agentVersionAtLeast('0.2.0')).toBe(true);
    expect(agentVersionAtLeast('1.0.0')).toBe(true);
    expect(agentVersionAtLeast('0.1.9-test')).toBe(true);
    expect(agentVersionAtLeast('0.1.8')).toBe(false);
    expect(agentVersionAtLeast('0.0.99')).toBe(false);
    expect(agentVersionAtLeast('not-a-version')).toBe(false);
  });

  it('requires both the protocol and the minimum version', () => {
    const health = {
      app: 'bikri-print-agent',
      version: '0.1.8',
      protocol: 1,
      platform: 'linux/amd64',
      paired: true,
      printers: 1,
    };
    expect(agentCompatible(health)).toBe(false);
    expect(agentCompatible({ ...health, version: '0.1.9' })).toBe(true);
    expect(agentCompatible({ ...health, version: '0.1.9', protocol: 2 })).toBe(
      false,
    );
    expect(agentCompatible(null)).toBe(false);
  });
});
