package backend

// clonePrinters copies the cached list and keeps an empty list non-nil, so the
// JSON/HTTP layer returns [] rather than null and a waiter on a failed refresh
// serves the cached "no printers" answer instead of a 502.
func clonePrinters(src []Printer) []Printer {
	out := make([]Printer, len(src))
	copy(out, src)
	return out
}
