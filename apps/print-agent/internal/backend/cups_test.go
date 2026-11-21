//go:build !windows

package backend

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestListPrintersCachesAndServesStale(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "lpstat")
	write := func(body string) {
		if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write("#!/bin/sh\ncase \"$1\" in\n  -e) echo Bixolon ;;\n  -d) echo 'system default destination: Bixolon' ;;\n  -v) echo 'device for Bixolon: usb://BIXOLON/SRP-350III' ;;\nesac\n")
	// Keep only the fake command on PATH: after it is removed the refresh must fail
	// (a system lpstat would otherwise answer successfully with no printers).
	t.Setenv("PATH", dir)
	// The process environment cache may have been populated by another test.
	cupsEnvOnce = sync.Once{}
	cupsEnvCache = nil

	b := &cupsBackend{}
	list, err := b.ListPrinters(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Name != "Bixolon" || !list[0].IsDefault {
		t.Fatalf("printers = %#v", list)
	}

	// A second call is served from the cache even with the command gone.
	if err := os.Remove(script); err != nil {
		t.Fatal(err)
	}
	list, err = b.ListPrinters(context.Background())
	if err != nil || len(list) != 1 {
		t.Fatalf("cached list = %#v, err = %v", list, err)
	}

	// An expired cache with a failed refresh keeps the last known list, so a
	// transient lpstat failure does not empty the printer wizard.
	b.printersMu.Lock()
	b.printersAt = time.Now().Add(-2 * cupsPrinterTTL)
	b.printersMu.Unlock()
	list, err = b.ListPrinters(context.Background())
	if err != nil {
		t.Fatalf("stale refresh failed: %v", err)
	}
	if len(list) != 1 || list[0].Name != "Bixolon" {
		t.Fatalf("stale list = %#v", list)
	}
}

func TestParseQueueNames(t *testing.T) {
	got := parseQueueNames("Bixolon\n\nOffice  \n")
	if len(got) != 2 || got[0] != "Bixolon" || got[1] != "Office" {
		t.Fatalf("names = %#v", got)
	}
}

func TestParseDefaultQueue(t *testing.T) {
	got := parseDefaultQueue("system default destination: Bixolon\n")
	if got != "Bixolon" {
		t.Fatalf("default = %q", got)
	}
}

func TestParseDevices(t *testing.T) {
	devices := parseDevices("device for Bixolon: usb://BIXOLON/SRP-350III\ndevice for Office: ipp://printer.local/ipp/print\n")
	if devices["Bixolon"] != "usb://BIXOLON/SRP-350III" {
		t.Fatalf("devices = %#v", devices)
	}
	if devices["Office"] != "ipp://printer.local/ipp/print" {
		t.Fatalf("devices = %#v", devices)
	}
}

func TestParseRequestID(t *testing.T) {
	if got := parseRequestID("request id is Bixolon-42 (1 file(s))\n"); got != "Bixolon-42" {
		t.Fatalf("request id = %q", got)
	}
	if got := parseRequestID("no id here"); got != "" {
		t.Fatalf("request id = %q", got)
	}
}

func TestCupsEnvForcesCLocale(t *testing.T) {
	env := cupsEnv([]string{"HOME=/home/shop", "LANG=ur_PK.UTF-8", "LC_ALL=ur_PK.UTF-8", "PATH=/usr/bin"})
	var localeAll, lang int
	for _, entry := range env {
		switch entry {
		case "LC_ALL=C":
			localeAll++
		case "LANG=C":
			lang++
		case "LANG=ur_PK.UTF-8", "LC_ALL=ur_PK.UTF-8":
			t.Fatalf("localized locale survived: %#v", env)
		}
	}
	if localeAll != 1 || lang != 1 {
		t.Fatalf("locale entries = %#v", env)
	}
	if env[len(env)-1] != "LANG=C" || env[len(env)-2] != "LC_ALL=C" {
		t.Fatalf("locale entries are not last: %#v", env)
	}
}

func TestSpoolIDPatternRejectsOptions(t *testing.T) {
	for _, id := range []string{"-a", "--all", "Bixolon", "Bixolon-x", "Bixolon-1;rm"} {
		if spoolIDPattern.MatchString(id) {
			t.Fatalf("unsafe spool id accepted: %q", id)
		}
	}
	for _, id := range []string{"Bixolon-42", "Office_1-7", "queue.name-123"} {
		if !spoolIDPattern.MatchString(id) {
			t.Fatalf("valid spool id rejected: %q", id)
		}
	}
}

func TestContainsJob(t *testing.T) {
	if !containsJob("Bixolon-42 user 1024 Wed\n", "Bixolon-42") {
		t.Fatal("job not found")
	}
	if containsJob("Bixolon-41 user 1024 Wed\n", "Bixolon-42") {
		t.Fatal("wrong job found")
	}
}

func TestDriverGeometryKeepsTheDotGrid(t *testing.T) {
	ppi, media, ok := driverGeometry(576, 2030, 80)
	if !ok || ppi != 183 || media != "Custom.80x282mm" {
		t.Fatalf("80 mm geometry = %d, %q, %v", ppi, media, ok)
	}
	ppi, media, ok = driverGeometry(384, 1600, 58)
	if !ok || ppi != 168 || media != "Custom.58x242mm" {
		t.Fatalf("58 mm geometry = %d, %q, %v", ppi, media, ok)
	}
	// Unknown paper falls back to the 80 mm default, missing dots disable it.
	if _, media, ok := driverGeometry(576, 2030, 0); !ok || media != "Custom.80x282mm" {
		t.Fatalf("default paper media = %q, %v", media, ok)
	}
	if _, _, ok := driverGeometry(0, 2030, 80); ok {
		t.Fatal("missing width produced geometry")
	}
	// Implausible ppi falls back to a 203 dpi head.
	if ppi, _, ok := driverGeometry(2048, 2030, 80); !ok || ppi != 203 {
		t.Fatalf("fallback ppi = %d, %v", ppi, ok)
	}
}

func TestCupsDriverArgsAreNotPageRelative(t *testing.T) {
	// `scaling=100` is page-relative and distorts receipts; the driver path must
	// keep the image at its real ppi and give CUPS a page tall enough for it.
	args := strings.Join(cupsDriverArgs(Job{WidthDots: 576, PaperMM: 80}, 2030), " ")
	want := "-o natural-scaling=100 -o ppi=183 -o media=Custom.80x282mm"
	if args != want {
		t.Fatalf("driver args = %q, want %q", args, want)
	}
	if got := strings.Join(cupsDriverArgs(Job{WidthDots: 0, PaperMM: 80}, 0), " "); got != "-o natural-scaling=100" {
		t.Fatalf("fallback args = %q", got)
	}
}

func TestQueueFault(t *testing.T) {
	cases := []struct {
		out  string
		code string
	}{
		{"printer Bixolon disabled since Mon 17 Nov 2025 - out of paper\n", "PAPER_OUT"},
		{"printer Bixolon disabled since Mon 17 Nov 2025 - media-empty\n", "PAPER_OUT"},
		{"printer Bixolon disabled since Mon 17 Nov 2025 - reason unknown\n", "PRINTER_OFFLINE"},
		{"printer Bixolon is idle.  enabled since Mon 17 Nov 2025\n", ""},
		{"printer Bixolon now printing Bixolon-42.  enabled since Mon 17 Nov 2025\n", ""},
	}
	for _, tc := range cases {
		code, _ := queueFault(tc.out)
		if code != tc.code {
			t.Fatalf("queueFault(%q) = %q, want %q", tc.out, code, tc.code)
		}
	}
}

// A caller with a short deadline (the /v1/health probe) must not cancel the
// refresh a 30 s print job is waiting on.
func TestListPrintersRefreshOutlivesTheFirstCaller(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "lpstat")
	body := "#!/bin/sh\nsleep 0.15\ncase \"$1\" in\n  -e) echo Bixolon ;;\n  -d) echo 'system default destination: Bixolon' ;;\n  -v) echo 'device for Bixolon: usb://BIXOLON/SRP-350III' ;;\nesac\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":/bin:/usr/bin")
	cupsEnvOnce = sync.Once{}
	cupsEnvCache = nil

	b := &cupsBackend{}
	short, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := b.ListPrinters(short); err == nil {
		t.Fatal("the short-deadline caller did not time out")
	}
	list, err := b.ListPrinters(context.Background())
	if err != nil {
		t.Fatalf("refresh failed after the first caller left: %v", err)
	}
	if len(list) != 1 || list[0].Name != "Bixolon" {
		t.Fatalf("printers = %#v", list)
	}
}
