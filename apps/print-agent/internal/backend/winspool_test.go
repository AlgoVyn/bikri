package backend

import "testing"

// gdiBands must partition the source bitmap into contiguous, non-empty bands in
// top-to-bottom order. GDI measures ySrc from the bottom of a DIB, so passing a
// source offset with a top-down DIB printed the last page first; slicing each
// band into its own DIB (ySrc = 0) requires the bands to be exact.
func TestGDIBandsPartitionTheSource(t *testing.T) {
	cases := []struct {
		name       string
		height     int
		destHeight int
		pageHeight int
		want       []gdiBand
	}{
		{
			// A receipt that fits one page is one full-height band.
			name: "single page", height: 1000, destHeight: 1000, pageHeight: 1000,
			want: []gdiBand{{SrcTop: 0, SrcHeight: 1000, DestHeight: 1000}},
		},
		{
			// The PRT-H1 case: two 600/400 pages, header first. The old ySrc
			// arithmetic printed [400,1000) and then [0,400).
			name: "reported reversed pages", height: 1000, destHeight: 1000, pageHeight: 600,
			want: []gdiBand{
				{SrcTop: 0, SrcHeight: 600, DestHeight: 600},
				{SrcTop: 600, SrcHeight: 400, DestHeight: 400},
			},
		},
		{
			// Exact division into equal pages.
			name: "exact multi-page", height: 900, destHeight: 900, pageHeight: 300,
			want: []gdiBand{
				{SrcTop: 0, SrcHeight: 300, DestHeight: 300},
				{SrcTop: 300, SrcHeight: 300, DestHeight: 300},
				{SrcTop: 600, SrcHeight: 300, DestHeight: 300},
			},
		},
		{
			// 1000 source rows stretched to 1500 device rows: page 1 covers
			// [0,666), page 2 the final partial band [666,1000). Truncating the
			// two divisions independently dropped row 999.
			name: "upscale final partial band", height: 1000, destHeight: 1500, pageHeight: 1000,
			want: []gdiBand{
				{SrcTop: 0, SrcHeight: 666, DestHeight: 1000},
				{SrcTop: 666, SrcHeight: 334, DestHeight: 500},
			},
		},
		{
			// 500 source rows stretched to 1500 device rows over three pages.
			name: "upscale", height: 500, destHeight: 1500, pageHeight: 700,
			want: []gdiBand{
				{SrcTop: 0, SrcHeight: 233, DestHeight: 700},
				{SrcTop: 233, SrcHeight: 233, DestHeight: 700},
				{SrcTop: 466, SrcHeight: 34, DestHeight: 100},
			},
		},
		{
			// 2030 source rows squeezed into 800 device rows: each page takes a
			// contiguous slice of the tall source image.
			name: "downscale", height: 2030, destHeight: 800, pageHeight: 300,
			want: []gdiBand{
				{SrcTop: 0, SrcHeight: 761, DestHeight: 300},
				{SrcTop: 761, SrcHeight: 761, DestHeight: 300},
				{SrcTop: 1522, SrcHeight: 508, DestHeight: 200},
			},
		},
		{
			// An extreme upscale maps a normal page to less than one source row.
			// The page must grow rather than emit an empty DIB.
			name: "extreme upscale", height: 10, destHeight: 1000, pageHeight: 50,
			want: []gdiBand{
				{SrcTop: 0, SrcHeight: 1, DestHeight: 100},
				{SrcTop: 1, SrcHeight: 1, DestHeight: 100},
				{SrcTop: 2, SrcHeight: 1, DestHeight: 100},
				{SrcTop: 3, SrcHeight: 1, DestHeight: 100},
				{SrcTop: 4, SrcHeight: 1, DestHeight: 100},
				{SrcTop: 5, SrcHeight: 1, DestHeight: 100},
				{SrcTop: 6, SrcHeight: 1, DestHeight: 100},
				{SrcTop: 7, SrcHeight: 1, DestHeight: 100},
				{SrcTop: 8, SrcHeight: 1, DestHeight: 100},
				{SrcTop: 9, SrcHeight: 1, DestHeight: 100},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bands := gdiBands(tc.height, tc.destHeight, tc.pageHeight)
			if len(bands) != len(tc.want) {
				t.Fatalf("bands = %+v, want %+v", bands, tc.want)
			}
			for i := range bands {
				if bands[i] != tc.want[i] {
					t.Fatalf("band %d = %+v, want %+v", i, bands[i], tc.want[i])
				}
			}
			assertBandCoverage(t, bands, tc.height, tc.destHeight)
		})
	}
}

// Every source row must appear exactly once across the bands, in order, and the
// device rows must add up to the requested height.
func assertBandCoverage(t *testing.T, bands []gdiBand, height, destHeight int) {
	t.Helper()
	next := 0
	destTotal := 0
	for i, band := range bands {
		if band.SrcTop != next {
			t.Fatalf("band %d starts at source %d, want %d (gap or overlap)", i, band.SrcTop, next)
		}
		if band.SrcHeight < 1 || band.DestHeight < 1 {
			t.Fatalf("band %d is empty: %+v", i, band)
		}
		next += band.SrcHeight
		destTotal += band.DestHeight
	}
	if next != height {
		t.Fatalf("bands cover %d source rows, want %d", next, height)
	}
	if destTotal != destHeight {
		t.Fatalf("bands cover %d device rows, want %d", destTotal, destHeight)
	}
}

func TestGDIBandsRejectsEmptyInput(t *testing.T) {
	for _, tc := range [][3]int{{0, 100, 100}, {100, 0, 100}, {100, 100, 0}, {-1, 100, 100}} {
		if bands := gdiBands(tc[0], tc[1], tc[2]); len(bands) != 0 {
			t.Fatalf("gdiBands(%d, %d, %d) = %+v, want none", tc[0], tc[1], tc[2], bands)
		}
	}
}

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
