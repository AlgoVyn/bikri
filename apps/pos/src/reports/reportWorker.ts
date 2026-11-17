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

async function compute(request: Request): Promise<Response> {
  const { id, tenantId, range, previousRange, options } = request;
  const db = openTenantDb(tenantId);
  try {
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
    return {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db.close();
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
      // own request was replaced; the next completed bundle is the current one.
      for (const id of superseded) post({ ...response, id });
      superseded.clear();
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
