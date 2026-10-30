import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, createTenant, getUsage, loginRedirect } from './api.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('admin api client', () => {
  it('reloads on 401 and does not settle', async () => {
    const reload = vi
      .spyOn(loginRedirect, 'reload')
      .mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'UNAUTHENTICATED' } }, 401),
      ),
    );
    let settled = false;
    void getUsage().then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(settled).toBe(false);
  });

  it('reloads on an opaque redirect', async () => {
    const reload = vi
      .spyOn(loginRedirect, 'reload')
      .mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            status: 0,
            type: 'opaqueredirect',
            ok: false,
          }) as Response,
      ),
    );
    let settled = false;
    void getUsage().then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(reload).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(settled).toBe(false);
  });

  it('sends JSON with same-origin credentials and surfaces the error message', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse(
          { error: { code: 'SLUG_TAKEN', message: 'That slug is taken' } },
          409,
        );
      }
      return jsonResponse({ email: 'operator@example.com' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUsage()).resolves.toEqual({
      email: 'operator@example.com',
    });
    const getInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/bikri/api/admin/usage');
    expect(getInit.credentials).toBe('same-origin');
    expect(getInit.redirect).toBe('manual');
    expect(getInit.method).toBe('GET');

    const body = {
      slug: 'karachi-1',
      display_name: 'Karachi',
      daily_write_budget: 7000,
      note: '',
    };
    await expect(createTenant(body)).rejects.toMatchObject({
      name: 'AdminApiError',
      code: 'SLUG_TAKEN',
      message: 'That slug is taken',
      status: 409,
    });
    const postInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(postInit.method).toBe('POST');
    expect(postInit.credentials).toBe('same-origin');
    expect(postInit.redirect).toBe('manual');
    expect(new Headers(postInit.headers).get('Content-Type')).toBe(
      'application/json',
    );
    expect(JSON.parse(String(postInit.body))).toEqual(body);
    await expect(createTenant(body)).rejects.toBeInstanceOf(AdminApiError);
  });
});
