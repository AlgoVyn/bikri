/**
 * Reports run in a worker (08 §7): a year of sales, payments and stock movements must not
 * block the counter's main thread. The worker opens the same tenant Dexie database and
 * returns a structured-cloneable bundle.
 *
 * Requests are serialised: a live-query change (for example a sync page) can send several
 * while one bundle is running, and running them concurrently multiplied CPU and IndexedDB
 * connections. Each request still gets its response, so the page's promise chain settles.
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

async function run(request: Request): Promise<void> {
  const { id, tenantId, range, previousRange, options } = request;
  const db = openTenantDb(tenantId);
  try {
    const bundle = await reportBundle(db, range, options);
    const previous =
      previousRange === undefined
        ? undefined
        : (await reportBundle(db, previousRange, options)).summary;
    scope.postMessage({ id, bundle, previous });
  } catch (error) {
    scope.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
}

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  queue = queue.then(() => run(request)).catch(() => undefined);
};
