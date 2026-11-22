/**
 * Reports run in a worker (08 §7): a year of sales, payments and stock movements must not
 * block the counter's main thread. The worker opens the same tenant Dexie database and
 * returns a structured-cloneable bundle.
 *
 * Requests are latest-wins: a live-query change (for example a sync page) can send several
 * while one bundle is running. Running them concurrently multiplied CPU and IndexedDB
 * connections; running every one in a FIFO queue made a 200-page pull queue 200 bundles.
 * The worker keeps at most one running and one pending request. A superseded pending
 * request is answered with the next completed bundle so its page promise still settles.
 */
import { openTenantDb } from '@bikri/db';
import {
  type ReportBundle,
  type ReportOptions,
  reportBundle,
} from '../data/reportBundle.ts';
import type { ReportRange } from '../data/reports.ts';

type Request = {
  id: number;
  tenantId: string;
  range: ReportRange;
  previousRange?: ReportRange;
  options: ReportOptions;
};

type Response = {
  id: number;
  bundle?: ReportBundle;
  previous?: ReportBundle['summary'];
  error?: string;
};

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Response) => void;
};

/* One Dexie connection per tenant in the worker. A report screen sends several
   requests while a pull changes rows; opening/closing the database each time paid
   the schema/connection cost repeatedly. */
let openDb: {
  tenantId: string;
  db: ReturnType<typeof openTenantDb>;
} | null = null;

function dbFor(tenantId: string): ReturnType<typeof openTenantDb> {
  if (openDb?.tenantId === tenantId) {
    // A Dexie handle closed by a versionchange (another tab upgraded the DB) or a
    // failed request must be reopened, not reused for every later report.
    if (openDb.db.isOpen()) return openDb.db;
    openDb = null;
  }
  openDb?.db.close();
  openDb = { tenantId, db: openTenantDb(tenantId) };
  return openDb.db;
}

function dropDb(db: ReturnType<typeof openTenantDb>): void {
  if (openDb?.db !== db) return;
  openDb = null;
  try {
    db.close();
  } catch {
    // Already closed; the next request opens a fresh handle.
  }
}

async function compute(request: Request): Promise<Response> {
  const { id, tenantId, range, previousRange, options } = request;
  // dbFor/openTenantDb can throw (a blocked upgrade, a lost connection); keep it in
  // the try so the page always gets a response instead of waiting forever.
  let db: ReturnType<typeof openTenantDb> | null = null;
  try {
    db = dbFor(tenantId);
    const bundle = await reportBundle(db, range, options);
    const previous =
      previousRange === undefined
        ? undefined
        : (
            await reportBundle(db, previousRange, {
              ...options,
              summaryOnly: true,
            })
          ).summary;
    return { id, bundle, previous };
  } catch (error) {
    if (db !== null) dropDb(db);
    return {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let running = false;
let pending: Request | null = null;
/** Requests replaced before they ran; they receive the next completed bundle. */
const superseded = new Set<number>();

function post(response: Response): void {
  scope.postMessage(response);
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending !== null) {
      const request = pending;
      pending = null;
      const response = await compute(request);
      post(response);
      // A page that sent a request while this one was running must settle even when its
      // own request was replaced; the next completed bundle is the current one. Wait
      // until no real request is queued, so a superseded id never receives the stale
      // bundle that was already replaced by the one about to run.
      if (pending === null) {
        for (const id of superseded) post({ ...response, id });
        superseded.clear();
      }
    }
  } finally {
    running = false;
  }
}

scope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  if (running) {
    if (pending !== null) superseded.add(pending.id);
    pending = request;
    return;
  }
  pending = request;
  void pump();
};
