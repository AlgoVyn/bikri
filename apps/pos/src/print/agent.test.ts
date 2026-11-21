import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpAgentClient } from './agent.ts';

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
