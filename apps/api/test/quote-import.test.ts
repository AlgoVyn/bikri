import { env } from 'cloudflare:workers';
import { newId } from '@bikri/core';
import { describe, expect, it } from 'vitest';
import { api, json, seedShop } from './helpers/fixtures.ts';
import { productRow, quoteOps } from './helpers/ops.ts';

type Err = { error: { code: string } };

const maintenance = async (tenantId: string, on: boolean) => {
  const res = await api(`/admin/tenants/${tenantId}/maintenance`, {
    method: 'POST',
    json: { on, reason: 'quotation import test' },
  });
  expect(res.status, await res.clone().text()).toBe(200);
};

const importRows = (tenantId: string, tbl: string, rows: unknown[]) =>
  api(`/admin/tenants/${tenantId}/import`, {
    method: 'POST',
    json: { tbl, rows, reason: 'quotation import test' },
  });

describe('quotation import backstops', () => {
  it('CORE-M2: an imported bundle keeps its bundle_since timestamp', async () => {
    const shop = await seedShop('Quote import bundle_since');
    await maintenance(shop.tenantId, true);
    try {
      const id = newId();
      const res = await importRows(shop.tenantId, 'products', [
        productRow(id, {
          kind: 'bundle',
          track_stock: 0,
          bundle_since: 1234,
        }),
      ]);
      expect(res.status, await res.text()).toBe(200);
      expect(
        await env.DB.prepare(
          'SELECT bundle_since FROM products WHERE tenant_id = ?1 AND id = ?2',
        )
          .bind(shop.tenantId, id)
          .first<{ bundle_since: number }>(),
      ).toEqual({ bundle_since: 1234 });
    } finally {
      await maintenance(shop.tenantId, false);
    }
  });

  it('CORE-M3: /import rejects an invalid round_total_to and a partial bundle line', async () => {
    const shop = await seedShop('Quote import guards');
    const quote = quoteOps(shop, shop.till, 1);
    await maintenance(shop.tenantId, true);
    try {
      const badQuote = await importRows(shop.tenantId, 'quotations', [
        { ...quote.row, round_total_to: 50 },
      ]);
      expect(badQuote.status).toBe(400);
      expect((await json<Err>(badQuote)).error.code).toBe('CONSTRAINT_FAILED');

      const goodQuote = await importRows(shop.tenantId, 'quotations', [
        quote.row,
      ]);
      expect(goodQuote.status, await goodQuote.text()).toBe(200);
      const badLine = await importRows(shop.tenantId, 'quotation_lines', [
        {
          ...quote.line,
          id: newId(),
          bundle_id: 'bundle-only',
          bundle_group: null,
        },
      ]);
      expect(badLine.status).toBe(400);
      expect((await json<Err>(badLine)).error.code).toBe('CONSTRAINT_FAILED');
    } finally {
      await maintenance(shop.tenantId, false);
    }
  });
});
