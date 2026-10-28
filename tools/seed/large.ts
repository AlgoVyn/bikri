#!/usr/bin/env node
/**
 * Generate e2e/fixtures/large.json (docs/10 §4): 1,000 products, 500 customers
 * and 20,000 bills over 120 days. The file is large and is gitignored; run:
 *
 *   node tools/seed/large.ts
 *
 * Performance tests build the same data in memory, so CI does not need the file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  customerRow,
  isoDate,
  productRow,
  saleRows,
} from '../perf/measure-d1.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.UTC(2026, 9, 28, 12, 0);
const DAY = 86_400_000;

export function largeFixture({
  products = 1000,
  customers = 500,
  bills = 20_000,
  days = 120,
  tenant = 'large',
} = {}) {
  const productRows = Array.from({ length: products }, (_, i) =>
    productRow(tenant, i, NOW),
  );
  const customerRows = Array.from({ length: customers }, (_, i) =>
    customerRow(tenant, i, NOW),
  );
  const billRows = Array.from({ length: bills }, (_, i) => {
    const bill = i + 1;
    const day = NOW - (bill % days) * DAY;
    return {
      day: isoDate(day),
      ...saleRows(
        tenant,
        bill,
        productRows.map((row) => row.id),
        customerRows[bill % customerRows.length]?.id ?? customerRows[0]?.id,
        day,
      ),
    };
  });
  return {
    meta: { products, customers, bills, days, tenant },
    products: productRows,
    customers: customerRows,
    bills: billRows,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const out = join(ROOT, 'e2e/fixtures/large.json');
  mkdirSync(dirname(out), { recursive: true });
  const fixture = largeFixture();
  writeFileSync(out, JSON.stringify(fixture));
  console.log(
    JSON.stringify({
      out,
      products: fixture.products.length,
      customers: fixture.customers.length,
      bills: fixture.bills.length,
    }),
  );
}
