package backend

import "testing"

func TestValidPrinterName(t *testing.T) {
	for _, name := range []string{"Bixolon", "BIXOLON SRP-350III", "Office_1", "काउंटर"} {
		if !ValidPrinterName(name) {
			t.Fatalf("valid printer rejected: %q", name)
		}
	}
	for _, name := range []string{"", "-a", "--", "Bixolon\n", "Bixolon\x00", string(make([]byte, 257))} {
		if ValidPrinterName(name) {
			t.Fatalf("unsafe printer accepted: %q", name)
		}
	}
}

func TestValidImageSize(t *testing.T) {
	if !validImageSize(512, 2000) {
		t.Fatal("receipt-sized image rejected")
	}
	for _, size := range [][2]int{{0, 100}, {100, 0}, {maxImageWidth + 1, 10}, {10, maxImageHeight + 1}, {4096, 4096}} {
		if validImageSize(size[0], size[1]) {
			t.Fatalf("oversized image accepted: %dx%d", size[0], size[1])
		}
	}
}

func TestGDISucceeded(t *testing.T) {
	if gdiSucceeded(1) == false || gdiSucceeded(42) == false {
		t.Fatal("successful GDI result rejected")
	}
	// SP_ERROR and GDI_ERROR are -1 in a uintptr-sized return.
	if gdiSucceeded(^uintptr(0)) || gdiSucceeded(uintptr(0xFFFFFFFF)) {
		t.Fatal("-1 GDI result treated as success")
	}
	if gdiSucceeded(0) {
		t.Fatal("zero GDI result treated as success")
	}
}
