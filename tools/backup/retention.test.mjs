import { describe, expect, it } from 'vitest';
import { backupKeyDate, retentionPlan } from './retention.mjs';

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

describe('backup retention', () => {
  it('reads only dated backup keys', () => {
    expect(backupKeyDate('d1/2026-10-28.sql.gz')).toBe('2026-10-28');
    expect(backupKeyDate('d1/2026-10-28.manifest.json')).toBe('2026-10-28');
    expect(backupKeyDate('d1/notes.txt')).toBeNull();
    expect(backupKeyDate('d1/2026-13-40.sql.gz')).toBeNull();
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
      ['d1/2026-01-01.sql.gz', 'd1/manual.txt', 'd1/2027-01-01.sql.gz'],
      '2026-10-28',
    );
    expect(plan.remove).toEqual([]);
  });
});
