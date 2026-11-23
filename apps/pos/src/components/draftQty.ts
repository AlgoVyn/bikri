/**
 * An editable quantity while it is still being typed.
 *
 * `null` (or a cleared field) is a valid draft, not an instruction to save zero, so the
 * line stays empty instead of snapping to "0"; totals count it as nothing and Save asks
 * for a positive quantity (UI-H4).
 */
export function draftQty(qty: number | null): number {
  return qty !== null && Number.isSafeInteger(qty) && qty > 0 ? qty : 0;
}
