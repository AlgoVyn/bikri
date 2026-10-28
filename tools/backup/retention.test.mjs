import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupKeyDate, main, retentionPlan } from './retention.mjs';

function keysFor(start, days) {
  const keys = [];
  for (let i = 0; i < days; i += 1) {
    const date = new Date(Date.UTC(2026, 7, start + i))
      .toISOString()
      .slice(0, 10);
    keys.push(`d1/${date}.sql.gz`, `d1/${date}.manifest.json`);
  }
  return keys;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
});

describe('backup retention', () => {
  it('reads only dated backup keys in the configured prefix', () => {
    expect(backupKeyDate('d1/2026-10-28.sql.gz')).toBe('2026-10-28');
    expect(backupKeyDate('d1/2026-10-28.manifest.json')).toBe('2026-10-28');
    expect(backupKeyDate('d1/notes.txt')).toBeNull();
    expect(backupKeyDate('d1/2026-02-31.sql.gz')).toBeNull();
    expect(backupKeyDate('archive/2026-10-28.sql.gz', 'archive/')).toBe(
      '2026-10-28',
    );
    expect(backupKeyDate('d1/2026-10-28.sql.gz', 'archive/')).toBeNull();
  });

  it('keeps 30 daily dates plus the 1st of up to 12 months', () => {
    const keys = keysFor(1, 90);
    const plan = retentionPlan(keys, '2026-10-28');
    expect(plan.keep).toContain('2026-09-01');
    expect(plan.keep).toContain('2026-09-30');
    expect(plan.keep).not.toContain('2026-09-02');
    expect(plan.remove).toContain('d1/2026-09-02.sql.gz');
    expect(plan.remove).toContain('d1/2026-09-02.manifest.json');
    expect(plan.remove).toHaveLength(116);
  });

  it('leaves unknown keys and future exports alone', () => {
    const plan = retentionPlan(
      ['d1/2025-01-02.sql.gz', 'd1/manual.txt', 'd1/2027-01-01.sql.gz'],
      '2026-10-28',
    );
    expect(plan.remove).toEqual([]);
  });

  it('deletes R2 keys with literal slashes through the API', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
    process.env.CLOUDFLARE_API_TOKEN = 'token';
    const calls = [];
    vi.stubGlobal('fetch', async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      if (init?.method === 'DELETE')
        return new Response(JSON.stringify({ success: true, result: {} }), {
          status: 200,
        });
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            { key: 'd1/2025-01-02.sql.gz' },
            ...keysFor(1, 30).map((key) => ({ key })),
          ],
          result_info: { is_truncated: false },
        }),
        { status: 200 },
      );
    });
    const plan = await main(['--today', '2026-10-28']);
    expect(plan.remove).toEqual(['d1/2025-01-02.sql.gz']);
    const del = calls.find((call) => call.method === 'DELETE');
    expect(del?.url).toContain('/objects/d1/2025-01-02.sql.gz');
    expect(del?.url).not.toContain('%2F');
  });
});
