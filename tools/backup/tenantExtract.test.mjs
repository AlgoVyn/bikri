import { describe, expect, it } from 'vitest';
import { SNAPSHOT_TABLES } from '../../apps/api/src/sync/tables.ts';
import { APP_VERSION as CORE_APP_VERSION } from '../../packages/core/src/version.ts';
import { EXPORT_TABLES } from './tables.mjs';
import {
  APP_VERSION,
  backupExportedAt,
  stripRow,
  tableCsv,
} from './tenant-extract.mjs';
import { zipStore } from './zip.mjs';

describe('tenant extraction', () => {
  it('removes the tenant and device secrets, and keeps snapshot tables only', () => {
    expect(
      stripRow('devices', {
        tenant_id: 't1',
        id: 'd1',
        token_hash: 'secret',
        name: 'Counter',
      }),
    ).toEqual({ id: 'd1', name: 'Counter' });
    expect(
      stripRow('products', {
        tenant_id: 't1',
        id: 'p1',
        name_en: 'Phone',
        on_hand_milli: 5000,
        cost_changed_at: 123,
        bundle_since: 456,
      }),
    ).toEqual({ id: 'p1', name_en: 'Phone', bundle_since: 456 });
    expect(EXPORT_TABLES).toEqual([...SNAPSHOT_TABLES]);
    for (const operational of [
      'tenant_usage',
      'change_log',
      'applied_tx',
      'enrolment_codes',
      'owner_email_codes',
    ])
      expect(EXPORT_TABLES).not.toContain(operational);
  });

  it('uses the nightly backup time and current app version', () => {
    expect(backupExportedAt('2026-10-27')).toBe(
      Date.parse('2026-10-27T05:05:00+05:00'),
    );
    expect(() => backupExportedAt('2026-02-31')).toThrow('not a real date');
    expect(() => backupExportedAt('27-10-2026')).toThrow('YYYY-MM-DD');
    expect(APP_VERSION).toBe(process.env.APP_VERSION ?? CORE_APP_VERSION);
  });

  it('writes human-readable CSV with rupees, percent and shop-local event time', () => {
    const csv = tableCsv(
      [
        {
          id: 's1',
          note: '=1+1',
          business_date: '2026-10-27',
          created_at: Date.parse('2026-10-27T06:00:00Z'),
          total: -12345,
          bundle_discount_total: 500,
          card_total: 750,
          bank_total: 250,
          udhaar_given: 1000,
          discount_type: 'pct',
          discount_value: 1250,
          cost_snapshot: 500,
          default_credit_limit: 4000000,
          round_total_to: 100,
          setup_completed_at: Date.parse('2026-10-27T06:00:00Z'),
        },
      ],
      'Asia/Kathmandu',
    ).replace(/^\uFEFF/u, '');
    expect(csv).toContain("'=1+1");
    expect(csv).toContain(',-123.45,');
    expect(csv).toContain(',5.00,');
    expect(csv).toContain(',7.50,');
    expect(csv).toContain(',2.50,');
    expect(csv).toContain(',10.00,');
    expect(csv).toContain(',12.50,');
    expect(csv).toContain(',40000.00,');
    expect(csv).toContain(',1.00,');
    expect(csv).toContain('2026-10-27T11:45:00+05:45');
  });

  it('writes a STORE zip with the manifest and every JSON/CSV pair', () => {
    const encoder = new TextEncoder();
    const bytes = zipStore(
      [
        { name: 'manifest.json', data: encoder.encode('{}') },
        { name: 'json/sales.json', data: encoder.encode('[]') },
        { name: 'csv/sales.csv', data: encoder.encode('') },
      ],
      0,
    );
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('manifest.json');
    expect(text).toContain('json/sales.json');
    expect(text).toContain('csv/sales.csv');
  });
});
