/**
 * Sales history worker (24 Nov review H1/L1). The full date range is read and filtered
 * off the main thread; the page receives only one page of rows plus the summary. The
 * worker keeps the last range in memory so a tab/filter/page change does not re-read
 * IndexedDB. A `version` from the page invalidates it after a write or pull.
 */
import { openTenantDb } from '@bikri/db';
import {
  filterSalesHistory,
  loadSalesHistory,
  loadSalesLineText,
  pageOf,
  type SalesDay,
  type SalesFilter,
  type SalesHistoryData,
  type SalesSummary,
} from '../data/salesHistory.ts';

export type SalesWorkerRequest = {
  id: number;
  tenantId: string;
  range: { from: string; to: string };
  filter: SalesFilter;
  page: number;
  pageSize: number;
  version: number;
};

export type SalesWorkerResponse = {
  id: number;
  summary?: SalesSummary;
  days?: SalesDay[];
  pageCount?: number;
  rowCount?: number;
  error?: string;
};

type Cache = {
  tenantId: string;
  key: string;
  version: number;
  data: SalesHistoryData;
  lineText?: Map<string, string>;
};

let cache: Cache | null = null;
let openDb: {
  tenantId: string;
  db: ReturnType<typeof openTenantDb>;
} | null = null;

function dbFor(tenantId: string): ReturnType<typeof openTenantDb> {
  if (openDb?.tenantId === tenantId) {
    if (openDb.db.isOpen()) return openDb.db;
    openDb = null;
  }
  openDb?.db.close();
  openDb = { tenantId, db: openTenantDb(tenantId) };
  return openDb.db;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SalesWorkerRequest>) => void) | null;
  postMessage: (message: SalesWorkerResponse) => void;
};

async function compute(
  request: SalesWorkerRequest,
): Promise<SalesWorkerResponse> {
  const { id, tenantId, range, filter, page, pageSize, version } = request;
  try {
    const db = dbFor(tenantId);
    const key = `${range.from}\u0000${range.to}`;
    if (
      cache?.tenantId !== tenantId ||
      cache.key !== key ||
      cache.version !== version
    ) {
      cache = {
        tenantId,
        key,
        version,
        data: await loadSalesHistory(db, range),
      };
    }
    const query = (filter.query ?? '').trim();
    if (query !== '' && cache.lineText === undefined)
      cache.lineText = await loadSalesLineText(db, range);
    const history = filterSalesHistory(
      cache.data,
      filter,
      query === '' ? undefined : cache.lineText,
    );
    const pages = pageOf(history.days, pageSize);
    return {
      id,
      summary: history.summary,
      days: pages[page] ?? [],
      pageCount: Math.max(1, pages.length),
      rowCount: history.rows.length,
    };
  } catch (error) {
    return {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let running = false;
let pending: SalesWorkerRequest | null = null;
/** Requests replaced before they ran; they receive the next completed result. */
const superseded = new Set<number>();

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending !== null) {
      const request = pending;
      pending = null;
      const response = await compute(request);
      scope.postMessage(response);
      // A page that posted while this request ran must settle even when its own
      // request was replaced. The next completed result is the current one.
      if (pending === null) {
        for (const id of superseded) scope.postMessage({ ...response, id });
        superseded.clear();
      }
    }
  } finally {
    running = false;
  }
}

scope.onmessage = (event) => {
  // `compute` reads and writes the module-level cache across awaits. Serialize requests
  // so a slower range cannot overwrite a newer cache or attach its line text to it.
  if (running) {
    if (pending !== null) superseded.add(pending.id);
    pending = event.data;
    return;
  }
  pending = event.data;
  void pump();
};
