//go:build windows

package backend

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The 300 ms /v1/health probe can expire while the shared EnumPrintersW refresh
// is still running; the previous list must be returned instead of zero printers
// (M17.4).
func TestListPrintersServesStaleWhenTheWaiterDeadlineExpires(t *testing.T) {
	done := make(chan struct{})
	b := &windowsBackend{
		printers:    []Printer{{Name: "Bixolon", IsDefault: true}},
		printersAt:  time.Now().Add(-2 * windowsPrinterTTL),
		refreshing:  true,
		refreshDone: done,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	list, err := b.ListPrinters(ctx)
	close(done)
	if err != nil {
		t.Fatalf("stale waiter returned an error: %v", err)
	}
	if len(list) != 1 || list[0].Name != "Bixolon" {
		t.Fatalf("stale list = %#v", list)
	}
}

// A caller that expired before the spooler handle was opened must not run the
// Win32 call at all (M17.5).
func TestOpenPrinterStopsBeforeACanceledCall(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := openPrinter(ctx, "Bixolon"); !errors.Is(err, context.Canceled) {
		t.Fatalf("openPrinter error = %v, want context.Canceled", err)
	}
}

func TestPrintImageStopsBeforeDecodingWhenCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := (&windowsBackend{}).printImage(ctx, &Job{
		Printer: "Bixolon",
		Mode:    "driver",
		Data:    []byte("not a png"),
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("printImage error = %v, want context.Canceled", err)
	}
}
