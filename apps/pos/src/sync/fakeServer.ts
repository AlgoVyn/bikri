/** In-memory stand-in for the Worker's till API, for sync unit tests (not shipped). */
import type { SyncedRow } from '@bikri/db';

export type Handler = (req: {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}) =>
  | { status?: number; json?: unknown; headers?: Record<string, string> }
  | undefined;

export class FakeServer {
  log: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  changes: {
    seq: number;
    tbl: string;
    op: 'upsert' | 'delete';
    row: SyncedRow;
  }[] = [];
  tables: Record<string, SyncedRow[]> = {};
  snapshotSeq: number | null = null;
  restoreEpoch = '1';
  restorePointAt = 0;
  floor = 0;
  tenantStatus: { status: 'active' | 'read_only'; since: number | null } = {
    status: 'active',
    since: null,
  };
  support: { until: number; reason: string } | null = null;
  results: (op: { op_id: string; tbl: string; row?: { id?: string } }) => {
    result: string;
    error_code?: string;
  } = () => ({ result: 'applied' });
  override: Handler | null = null;
  online = true;
  device = {
    id: 'dev-1',
    name: 'Counter 1',
    branch_id: 'br-1',
    device_code: 'A',
    is_admin: true,
    last_invoice_seq: 0,
  };

  status() {
    return {
      tenant_status: this.tenantStatus,
      support: this.support,
      poll_after_ms: 60_000,
    };
  }

  fetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (!this.online) throw new TypeError('Failed to fetch');
    const url = new URL(String(input), 'https://algovyn.com');
    const path = url.pathname.replace(/^\/bikri\/api/, '');
    const body =
      typeof init.body === 'string'
        ? JSON.parse(init.body)
        : (init.body ?? null);
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    this.log.push({ method, path, body, headers });
    const respond = (
      status: number,
      json: unknown,
      extra: Record<string, string> = {},
    ) =>
      new Response(JSON.stringify(json), {
        status,
        headers: { 'content-type': 'application/json', ...extra },
      });
    const o = this.override?.({
      method,
      path,
      query: url.searchParams,
      body,
      headers,
    });
    if (o) return respond(o.status ?? 200, o.json ?? {}, o.headers);
    const now = Date.now();
    if (path === '/me') {
      return respond(200, {
        tenant: {
          id: 't1',
          display_name: 'Shop',
          status: this.tenantStatus.status,
        },
        device: this.device,
        shop_setup_completed: true,
        server_time: now,
        ...this.status(),
      });
    }
    if (path === '/sync/push') {
      const ops = (
        body as { ops: { op_id: string; tbl: string; row?: { id?: string } }[] }
      ).ops;
      return respond(200, {
        results: ops.map((op) => ({ op_id: op.op_id, ...this.results(op) })),
        server_time: now,
        latest_seq: this.changes.at(-1)?.seq ?? 0,
        ...this.status(),
      });
    }
    if (path === '/sync/pull') {
      const since = Number(url.searchParams.get('since'));
      if (since < this.floor)
        return respond(410, {
          error: {
            code: 'SNAPSHOT_REQUIRED',
            message: 'x',
            details: { change_log_floor: this.floor },
          },
        });
      const limit = Number(url.searchParams.get('limit') ?? 500);
      const rows = this.changes.filter((c) => c.seq > since);
      const page = rows.slice(0, limit);
      return respond(200, {
        changes: page,
        next_since: page.at(-1)?.seq ?? since,
        has_more: rows.length > limit,
        server_time: now,
        restore_epoch: this.restoreEpoch,
        restore_point_at: this.restorePointAt,
        ...this.status(),
      });
    }
    if (path === '/sync/snapshot') {
      const tbl = url.searchParams.get('tbl');
      if (!tbl) {
        return respond(200, {
          snapshot_seq:
            this.snapshotSeq ?? this.changes.at(-1)?.seq ?? this.floor,
          tables: Object.entries(this.tables).map(([t, rows]) => ({
            tbl: t,
            rows: rows.length,
          })),
        });
      }
      const after = url.searchParams.get('after') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 500);
      const all = (this.tables[tbl] ?? [])
        .filter((r) => r.id > after)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const page = all.slice(0, limit);
      return respond(200, {
        tbl,
        rows: page,
        next_after: page.at(-1)?.id ?? after,
        has_more: all.length > limit,
      });
    }
    return respond(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
  };
}
