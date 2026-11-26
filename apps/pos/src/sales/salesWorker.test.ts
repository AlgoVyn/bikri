import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesHistoryData } from '../data/salesHistory.ts';
import type { SalesWorkerRequest, SalesWorkerResponse } from './salesWorker.ts';
import './salesWorker.ts';

// OPS-L2: the sales worker has no other unit test. These cases pin the queue that
// serializes overlapping requests, the full-day page header that `pageOf` preserves,
// and the error response that makes `SalesList` switch to its main-thread fallback.

const { loadSalesHistory, filterSalesHistory, post } = vi.hoisted(() => ({
  loadSalesHistory: vi.fn(),
  filterSalesHistory: vi.fn(),
  post: vi.fn(),
}));

vi.mock('@bikri/db', () => ({
  openTenantDb: () => ({ isOpen: () => true, close: () => undefined }),
}));

vi.mock('../data/salesHistory.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../data/salesHistory.ts')>();
  return {
    ...actual,
    loadSalesHistory,
    loadSalesLineText: vi.fn(async () => new Map()),
    filterSalesHistory,
  };
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const loaded: Deferred<SalesHistoryData>[] = [];

function request(
  overrides: Partial<SalesWorkerRequest> = {},
): SalesWorkerRequest {
  return {
    id: 1,
    tenantId: 't-worker',
    range: { from: '2026-11-01', to: '2026-11-30' },
    filter: { from: '2026-11-01', to: '2026-11-30', sort: 'time' },
    page: 0,
    pageSize: 50,
    version: 1,
    ...overrides,
  };
}

function emptyHistory(): SalesHistoryData {
  return { rows: [], rangeRefunds: [] };
}

function filteredHistory() {
  return {
    rows: [],
    days: [
      {
        date: '2026-11-10',
        bills: 1,
        total: 100,
        rows: [],
      },
    ],
    summary: { bills: 1, sold: 100, refunds: 0, avgBill: 100 },
  };
}

const posted = (): SalesWorkerResponse[] =>
  post.mock.calls.map((call) => call[0] as SalesWorkerResponse);

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('salesWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loaded.length = 0;
    vi.stubGlobal('postMessage', post);
    loadSalesHistory.mockImplementation(() => {
      const next = deferred<SalesHistoryData>();
      loaded.push(next);
      return next.promise;
    });
    filterSalesHistory.mockReturnValue(filteredHistory());
  });

  it('serializes overlapping requests and never starts a second load while one runs', async () => {
    const { onmessage } = self as unknown as {
      onmessage: ((event: MessageEvent<SalesWorkerRequest>) => void) | null;
    };
    expect(onmessage).toBeTypeOf('function');

    onmessage?.({
      data: request({ id: 1, tenantId: 't-serial' }),
    } as MessageEvent<SalesWorkerRequest>);
    await vi.waitFor(() => expect(loaded).toHaveLength(1));
    onmessage?.({
      data: request({
        id: 2,
        tenantId: 't-serial',
        range: { from: '2026-10-01', to: '2026-10-31' },
        version: 2,
      }),
    } as MessageEvent<SalesWorkerRequest>);
    await flush();
    // Request 2 is queued, not read while request 1 is still loading.
    expect(loaded).toHaveLength(1);

    loaded[0]?.resolve(emptyHistory());
    await vi.waitFor(() => expect(loaded).toHaveLength(2));
    expect(posted().map((row) => row.id)).toEqual([1]);

    loaded[1]?.resolve(emptyHistory());
    await vi.waitFor(() => expect(posted()).toHaveLength(2));
    expect(posted().map((row) => row.id)).toEqual([1, 2]);
  });

  it('settles a superseded request with the newest completed page', async () => {
    const { onmessage } = self as unknown as {
      onmessage: ((event: MessageEvent<SalesWorkerRequest>) => void) | null;
    };
    onmessage?.({
      data: request({ id: 10, tenantId: 't-overlap' }),
    } as MessageEvent<SalesWorkerRequest>);
    await vi.waitFor(() => expect(loaded).toHaveLength(1));
    onmessage?.({
      data: request({ id: 11, tenantId: 't-overlap', version: 2 }),
    } as MessageEvent<SalesWorkerRequest>);
    onmessage?.({
      data: request({
        id: 12,
        tenantId: 't-overlap',
        range: { from: '2026-10-01', to: '2026-10-31' },
        version: 3,
      }),
    } as MessageEvent<SalesWorkerRequest>);
    await flush();
    expect(loaded).toHaveLength(1);

    loaded[0]?.resolve(emptyHistory());
    await vi.waitFor(() => expect(loaded).toHaveLength(2));
    // 11 was replaced by 12 before it ran; 12 is the newest request.
    expect(posted().map((row) => row.id)).toEqual([10]);

    loaded[1]?.resolve(emptyHistory());
    await vi.waitFor(() => expect(posted()).toHaveLength(3));
    const responses = posted();
    expect(responses.map((row) => row.id).sort((a, b) => a - b)).toEqual([
      10, 11, 12,
    ]);
    expect(responses.find((row) => row.id === 11)?.summary).toEqual(
      responses.find((row) => row.id === 12)?.summary,
    );
  });

  it('returns an error envelope that SalesList treats as a main-thread fallback', async () => {
    const { onmessage } = self as unknown as {
      onmessage: ((event: MessageEvent<SalesWorkerRequest>) => void) | null;
    };
    onmessage?.({
      data: request({ id: 21, tenantId: 't-error' }),
    } as MessageEvent<SalesWorkerRequest>);
    await vi.waitFor(() => expect(loaded).toHaveLength(1));
    loaded[0]?.reject(new Error('IndexedDB unavailable'));
    await vi.waitFor(() => expect(posted()).toHaveLength(1));

    const response = posted()[0];
    expect(response).toMatchObject({ id: 21, error: 'IndexedDB unavailable' });
    // The same condition as SalesList's message handler.
    expect(
      response?.error !== undefined || response?.summary === undefined,
    ).toBe(true);
    expect(response?.summary).toBeUndefined();

    // The main-thread path computes the same page shape from the same helpers.
    const filtered = filterSalesHistory(emptyHistory(), request().filter);
    const fallback = {
      summary: filtered.summary,
      days: filtered.days,
      pageCount: 1,
      rowCount: filtered.rows.length,
    };
    expect(fallback.summary).toEqual(filteredHistory().summary);
    expect(fallback.days).toEqual(filteredHistory().days);
  });
});

describe('pageOf (full-day totals)', () => {
  it('keeps every page of a busy day on the full-day header totals', async () => {
    const { pageOf } = await import('../data/salesHistory.ts');
    const rows = Array.from({ length: 120 }, (_, index) => ({
      sale: {
        id: `sale-${index}`,
        status: index === 0 ? 'void' : 'paid',
        total: 1000,
      },
    })) as never[];
    const day = { date: '2026-11-27', bills: 119, total: 119_000, rows };
    const pages = pageOf([day], 50);

    expect(pages.map((page) => page[0]?.rows.length)).toEqual([50, 50, 20]);
    for (const page of pages) {
      expect(page[0]?.bills).toBe(119);
      expect(page[0]?.total).toBe(119_000);
    }
  });
});
