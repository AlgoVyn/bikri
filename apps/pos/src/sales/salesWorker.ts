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

function pageOf(days: SalesDay[], size: number): SalesDay[][] {
  const pages: SalesDay[][] = [];
  let current: SalesDay[] = [];
  let count = 0;
  const push = () => {
    if (current.length > 0) pages.push(current);
    current = [];
    count = 0;
  };
  for (const day of days) {
    if (day.rows.length > size) {
      push();
      for (let at = 0; at < day.rows.length; at += size) {
        const rows = day.rows.slice(at, at + size);
        let bills = 0;
        let total = 0;
        for (const row of rows) {
          if (row.sale.status === 'void') continue;
          bills += 1;
          total += Number(row.sale.total ?? 0);
        }
        pages.push([{ date: day.date, bills, total, rows }]);
      }
      continue;
    }
    if (current.length > 0 && count + day.rows.length > size) push();
    current.push(day);
    count += day.rows.length;
  }
  push();
  return pages;
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

scope.onmessage = (event) => {
  const request = event.data;
  void compute(request).then((response) => scope.postMessage(response));
};
