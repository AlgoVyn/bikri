package backend

import "testing"

// GetDefaultPrinterW(NULL, &needed) returns FALSE with ERROR_INSUFFICIENT_BUFFER
// while filling `needed`; treating any FALSE as failure hid the default printer
// on every Windows machine.
func TestAcceptDefaultPrinterBuffer(t *testing.T) {
	cases := []struct {
		name   string
		r1     uintptr
		errno  uint32
		needed uint32
		want   bool
	}{
		{"length query", 0, errorInsufficientBuffer, 12, true},
		{"no default printer", 0, 0, 0, false},
		{"unexpected failure", 0, 5, 12, false},
		{"unexpected success", 1, 0, 12, true},
		{"buffer size lost", 0, errorInsufficientBuffer, 0, false},
	}
	for _, tc := range cases {
		if got := acceptDefaultPrinterBuffer(tc.r1, tc.errno, tc.needed); got != tc.want {
			t.Fatalf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

// MM_TEXT draws in device pixels. A 576-dot receipt on a 600 dpi driver must be
// scaled to the physical paper width, and never past the printable area.
func TestGDITargetSize(t *testing.T) {
	// 600 dpi × 80 mm ≈ 1890 px.
	if got, _ := gdiTargetSize(576, 1200, 80, 600, 600, 4800); got != 1890 {
		t.Fatalf("600 dpi width = %d, want 1890", got)
	}
	// 180 dpi × 58 mm ≈ 411 px.
	if got, _ := gdiTargetSize(384, 800, 58, 180, 180, 1000); got != 411 {
		t.Fatalf("180 dpi width = %d, want 411", got)
	}
	// Without paper geometry the image keeps its dot width.
	if got, _ := gdiTargetSize(576, 1200, 0, 203, 203, 4800); got != 576 {
		t.Fatalf("unknown paper width = %d, want 576", got)
	}
	// The printable width wins over the paper width.
	width, height := gdiTargetSize(576, 1200, 80, 600, 600, 1000)
	if width != 1000 || height != 2083 {
		t.Fatalf("clamped size = %dx%d, want 1000x2083", width, height)
	}
	// LOGPIXELSY is the fallback when a driver reports no horizontal dpi.
	if got, _ := gdiTargetSize(576, 1200, 80, 0, 203, 4800); got != 639 {
		t.Fatalf("dpiY fallback width = %d, want 639", got)
	}
	if width, height := gdiTargetSize(0, 0, 80, 203, 203, 4800); width != 0 || height != 0 {
		t.Fatalf("empty image = %dx%d", width, height)
	}
}
