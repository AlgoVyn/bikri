//go:build !windows

package backend

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// cupsBackend talks to CUPS with the standard command-line tools. It works on
// Linux and macOS and never needs root: the agent runs as the logged-in user and
// CUPS policy decides whether that user may print.
type cupsBackend struct {
	printersMu sync.Mutex
	printers   []Printer
	printersAt time.Time
}

var (
	requestIDPattern = regexp.MustCompile(`request id is (\S+)`)
	spoolIDPattern   = regexp.MustCompile(`^[A-Za-z0-9._-]+-[0-9]+$`)
)

func (b *cupsBackend) ListPrinters(ctx context.Context) ([]Printer, error) {
	// `/v1/jobs` verifies the requested queue, and health/printers/diagnostics
	// each list again. Without this cache every print spawned 1–3 `lpstat`
	// processes (the Windows backend already caches for 10 s).
	b.printersMu.Lock()
	if b.printers != nil && time.Since(b.printersAt) < 10*time.Second {
		list := append([]Printer(nil), b.printers...)
		b.printersMu.Unlock()
		return list, nil
	}
	b.printersMu.Unlock()
	namesOut, err := run(ctx, "lpstat", "-e")
	if err != nil {
		return nil, &Error{Code: "CUPS_UNAVAILABLE", Message: err.Error()}
	}
	names := parseQueueNames(namesOut)
	if len(names) == 0 {
		empty := []Printer{}
		b.printersMu.Lock()
		b.printers = empty
		b.printersAt = time.Now()
		b.printersMu.Unlock()
		return empty, nil
	}
	defaultName := ""
	if out, err := run(ctx, "lpstat", "-d"); err == nil {
		defaultName = parseDefaultQueue(out)
	}
	devices := map[string]string{}
	if out, err := run(ctx, "lpstat", "-v"); err == nil {
		devices = parseDevices(out)
	}
	printers := make([]Printer, 0, len(names))
	for _, name := range names {
		printers = append(printers, Printer{
			Name:      name,
			Port:      devices[name],
			IsDefault: name == defaultName,
		})
	}
	b.printersMu.Lock()
	b.printers = append([]Printer(nil), printers...)
	b.printersAt = time.Now()
	b.printersMu.Unlock()
	return printers, nil
}

func (b *cupsBackend) Print(ctx context.Context, job Job) (string, error) {
	if !ValidPrinterName(job.Printer) {
		return "", &Error{Code: "UNKNOWN_PRINTER", Message: "no valid printer name"}
	}
	ext := ".bin"
	if job.Encoding == "png" {
		ext = ".png"
	}
	file, err := os.CreateTemp("", "bikri-print-*"+ext)
	if err != nil {
		return "", &Error{Code: "SPOOL_ERROR", Message: err.Error()}
	}
	path := file.Name()
	defer os.Remove(path)
	if _, err := file.Write(job.Data); err != nil {
		file.Close()
		return "", &Error{Code: "SPOOL_ERROR", Message: err.Error()}
	}
	if err := file.Close(); err != nil {
		return "", &Error{Code: "SPOOL_ERROR", Message: err.Error()}
	}

	copies := job.Copies
	if copies < 1 {
		copies = 1
	}
	args := []string{
		"-d", job.Printer,
		"-n", fmt.Sprintf("%d", copies),
		"-t", "Bikri " + job.ID,
	}
	if job.Mode == "raw" {
		args = append(args, "-o", "raw")
	} else {
		// The PNG already includes the paper-width padding; do not let CUPS
		// fit-to-page it (which would ignore the 1:1 dot width).
		args = append(args, "-o", "scaling=100")
	}
	// `--` ends options: a file name or queue that begins with `-` can never be
	// interpreted as another lp flag.
	args = append(args, "--", path)
	out, err := run(ctx, "lp", args...)
	if err != nil {
		return "", &Error{Code: "SPOOL_ERROR", Message: err.Error()}
	}
	// Never fall back to the client-supplied id: `cancel` would later run against
	// that value and could interpret it as an option (e.g. `-a` cancels every job).
	// An unparsed id is uncancelable but the job has still been spooled.
	return parseRequestID(out), nil
}

func (b *cupsBackend) Status(ctx context.Context, printer, spoolID string) (Status, error) {
	if !ValidPrinterName(printer) {
		return Status{State: "failed", Error: "UNKNOWN_PRINTER"}, nil
	}
	if spoolID == "" {
		// The spool succeeded but CUPS did not print a request id; there is nothing
		// to poll, so treat the job as accepted instead of leaving it "printing".
		return Status{State: "done"}, nil
	}
	active, err := run(ctx, "lpstat", "-W", "not-completed", "-o", printer)
	if err != nil {
		return Status{}, &Error{Code: "CUPS_UNAVAILABLE", Message: err.Error()}
	}
	if spoolID == "" || containsJob(active, spoolID) {
		return Status{State: "printing"}, nil
	}
	completed, err := run(ctx, "lpstat", "-W", "completed", "-o", printer)
	if err == nil && containsJob(completed, spoolID) {
		return Status{State: "done"}, nil
	}
	// CUPS removes completed jobs from the short listing after a while. If the
	// job is no longer active, treat it as done rather than leaving the till
	// waiting forever; a failed job normally remains active with a reason.
	return Status{State: "done"}, nil
}

func (b *cupsBackend) Cancel(ctx context.Context, printer, spoolID string) error {
	if !ValidPrinterName(printer) || !spoolIDPattern.MatchString(spoolID) {
		return &Error{Code: "CANCEL_FAILED", Message: "invalid printer or job id"}
	}
	if _, err := run(ctx, "cancel", "--", spoolID); err != nil {
		return &Error{Code: "CANCEL_FAILED", Message: err.Error()}
	}
	return nil
}

// cupsEnv forces the C locale so lp/lpstat output is parseable on non-English
// desktops. Replacing an inherited LC_ALL/LANG avoids duplicate variables where
// libc would otherwise keep the first (localized) value.
func cupsEnv(env []string) []string {
	out := make([]string, 0, len(env)+2)
	for _, entry := range env {
		if strings.HasPrefix(entry, "LC_ALL=") || strings.HasPrefix(entry, "LANG=") {
			continue
		}
		out = append(out, entry)
	}
	return append(out, "LC_ALL=C", "LANG=C")
}

func run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = cupsEnv(os.Environ())
	out, err := cmd.CombinedOutput()
	if err != nil {
		text := strings.TrimSpace(string(out))
		if text == "" {
			text = err.Error()
		}
		return "", fmt.Errorf("%s %s: %s", name, strings.Join(args, " "), text)
	}
	return string(out), nil
}

func parseQueueNames(out string) []string {
	var names []string
	for _, line := range strings.Split(out, "\n") {
		if name := strings.TrimSpace(line); name != "" {
			names = append(names, name)
		}
	}
	return names
}

func parseDefaultQueue(out string) string {
	const marker = "system default destination:"
	for _, line := range strings.Split(out, "\n") {
		if at := strings.Index(line, marker); at >= 0 {
			return strings.TrimSpace(line[at+len(marker):])
		}
	}
	return ""
}

func parseDevices(out string) map[string]string {
	devices := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "device for ") {
			continue
		}
		rest := strings.TrimPrefix(line, "device for ")
		at := strings.Index(rest, ":")
		if at < 0 {
			continue
		}
		devices[strings.TrimSpace(rest[:at])] = strings.TrimSpace(rest[at+1:])
	}
	return devices
}

func parseRequestID(out string) string {
	match := requestIDPattern.FindStringSubmatch(out)
	if len(match) == 2 {
		return match[1]
	}
	return ""
}

func containsJob(out, spoolID string) bool {
	for _, field := range strings.Fields(out) {
		if field == spoolID {
			return true
		}
	}
	return false
}
