import type { BikriDb } from '@bikri/db';

/**
 * Open the cash drawer for a cash movement that has no printed receipt (a payment,
 * pay-in/out, expense, or a sale/refund with auto-print off). The receipt path already
 * appends a drawer kick for printed cash sales/refunds, so callers only use this when no
 * receipt job will kick it. Best effort: a missing/unsupported printer must not fail the
 * money action; F9 remains available.
 */
export async function kickDrawerForCash(db: BikriDb): Promise<void> {
  try {
    const [{ kickDrawer, readPrinter }, { browserPrintDeps }] =
      await Promise.all([
        import('./printService.ts'),
        import('./printDeps.ts'),
      ]);
    const printer = await readPrinter(db);
    if (!printer?.transport || printer.drawer === false) return;
    await kickDrawer(db, printer, browserPrintDeps());
  } catch {
    // No printer / browser print cannot kick the drawer; the cashier can use F9.
  }
}
