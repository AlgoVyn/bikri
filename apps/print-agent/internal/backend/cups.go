//go:build !windows

package backend

import (
	"context"
	"fmt"
	"math"
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
	printersMu  sync.Mutex
	printers    []Printer
	printersAt  time.Time
	refreshing  bool
	refreshDone chan struct{}
	refreshErr  error
}

// CUPS enumeration is three fast local commands; a short TTL keeps a newly added
// queue visible while singleflight prevents one refresh per waiter.
const cupsPrinterTTL = 10 * time.Second

// cupsRefreshTimeout bounds a shared refresh. It runs independently of the
// caller that started it (see ListPrinters): `/v1/health` leads with a 300 ms
// deadline while a 30 s print job may be waiting on the same singleflight.
const cupsRefreshTimeout = 15 * time.Second

var (
	requestIDPattern = regexp.MustCompile(`request id is (\S+)`)
	// CUPS `cancel` has no end-of-options marker (`cancel -- id` fails with
	// "unknown option '-'"), so the queue part cannot start with a hyphen and must
	// not contain whitespace, `/` or `#`. Unicode and `+` queue names are valid.
	spoolIDPattern = regexp.MustCompile(`^[^\s/#-][^\s/#]*-[0-9]+$`)
)

/** clonePrinters keeps an empty list non-nil, so JSON is [] rather than null. */
func clonePrinters(src []Printer) []Printer {
	out := make([]Printer, len(src))
	copy(out, src)
	return out
}

func (b *cupsBackend) ListPrinters(ctx context.Context) ([]Printer, error) {
	// `/v1/jobs` verifies the requested queue, and health/printers/diagnostics
	// each list again. One refresh serves every waiter, and a transient lpstat
	// failure keeps the last known list instead of emptying the wizard.
	b.printersMu.Lock()
	if b.printers != nil && time.Since(b.printersAt) < cupsPrinterTTL {
		list := clonePrinters(b.printers)
		b.printersMu.Unlock()
		return list, nil
	}
	if b.refreshing {
		done := b.refreshDone
		b.printersMu.Unlock()
		list, refreshErr, waitErr := b.wait(ctx, done)
		if waitErr != nil {
			return nil, waitErr
		}
		if list == nil && refreshErr != nil {
			return nil, refreshErr
		}
		return list, nil
	}
	b.refreshing = true
	b.refreshDone = make(chan struct{})
	done := b.refreshDone
	hasStale := b.printers != nil
	stale := clonePrinters(b.printers)
	b.printersMu.Unlock()

	// A refresh runs independently of the caller that started it: `/v1/health`
	// leads with a 300 ms deadline while a 30 s print job may be waiting on the
	// same singleflight. Inheriting the first caller's ctx failed the print job
	// when the health probe gave up.
	go func() {
		refreshCtx, cancel := context.WithTimeout(context.Background(), cupsRefreshTimeout)
		defer cancel()
		b.refresh(refreshCtx, done)
	}()

	list, refreshErr, waitErr := b.wait(ctx, done)
	if waitErr != nil {
		// This caller gave up; the refresh keeps running for the next waiter.
		return nil, waitErr
	}
	if refreshErr != nil && hasStale {
		return stale, nil
	}
	return list, refreshErr
}

// wait blocks until the singleflight finishes or the caller's deadline wins.
func (b *cupsBackend) wait(ctx context.Context, done chan struct{}) ([]Printer, error, error) {
	select {
	case <-done:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	b.printersMu.Lock()
	list := append([]Printer(nil), b.printers...)
	refreshErr := b.refreshErr
	b.printersMu.Unlock()
	return list, refreshErr, nil
}

// refresh runs the enumeration and always publishes a result: a panic in a
// waiter-visible singleflight would otherwise leave `refreshing` true and make
// every later call block on a channel that is never closed.
func (b *cupsBackend) refresh(ctx context.Context, done chan struct{}) (list []Printer, err error) {
	defer func() {
		if value := recover(); value != nil {
			err = &Error{Code: "CUPS_UNAVAILABLE", Message: fmt.Sprint("printer enumeration failed: ", value)}
		}
		b.printersMu.Lock()
		if err == nil {
			// Keep an empty result non-nil so "no printers" is cached too.
			b.printers = append([]Printer{}, list...)
			b.printersAt = time.Now()
		}
		b.refreshErr = err
		b.refreshing = false
		b.refreshDone = nil
		close(done)
		b.printersMu.Unlock()
	}()
	return b.enumerate(ctx)
}

func (b *cupsBackend) enumerate(ctx context.Context) ([]Printer, error) {
	namesOut, err := run(ctx, "lpstat", "-e")
	if err != nil {
		return nil, &Error{Code: "CUPS_UNAVAILABLE", Message: err.Error()}
	}
	names := parseQueueNames(namesOut)
	if len(names) == 0 {
		return []Printer{}, nil
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
	return printers, nil
}

func (b *cupsBackend) Print(ctx context.Context, job Job) (string, error) {
	if !ValidPrinterName(job.Printer) {
		return "", &Error{Code: "UNKNOWN_PRINTER", Message: "no valid printer name"}
	}
	ext := ".bin"
	var imageHeight, imageWidth int
	if job.Encoding == "png" {
		ext = ".png"
		// Validate here too so a direct backend caller (or a future transport)
		// cannot hand CUPS filters an unbounded PNG. The manager also validates
		// centrally before any backend runs.
		width, height, err := ImageConfig(job.Data)
		if err != nil {
			return "", err
		}
		imageWidth, imageHeight = width, height
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
		if job.WidthDots <= 0 {
			job.WidthDots = imageWidth
		}
		args = append(args, cupsDriverArgs(job, imageHeight)...)
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

// cupsDriverArgs keeps a rendered receipt at its real dot size. CUPS `scaling`
// is page-relative: `-o scaling=100` stretches or shrinks the PNG to the whole
// media (an A4 queue blew a 58 mm receipt across the sheet, and a tall receipt
// was squeezed onto one thermal page). `natural-scaling=100` keeps one image
// pixel at the requested ppi, and a custom media height lets the driver feed the
// whole receipt instead of fitting it to a shorter page.
func cupsDriverArgs(job Job, heightDots int) []string {
	ppi, media, ok := driverGeometry(job.WidthDots, heightDots, job.PaperMM)
	if !ok {
		return []string{"-o", "natural-scaling=100"}
	}
	return []string{
		"-o", "natural-scaling=100",
		"-o", fmt.Sprintf("ppi=%d", ppi),
		"-o", "media=" + media,
	}
}

// driverGeometry derives the image resolution and page length. The PNG is the
// full paper-width dot grid (576 dots for 80 mm, 384 for 58 mm), so the physical
// paper width fixes the ppi. Unknown or implausible values fall back to 203 dpi,
// the common thermal head.
func driverGeometry(widthDots, heightDots, paperMm int) (ppi int, media string, ok bool) {
	if widthDots < 1 || heightDots < 1 {
		return 0, "", false
	}
	if paperMm != 58 && paperMm != 80 {
		paperMm = 80
	}
	ppi = int(math.Round(float64(widthDots) * 25.4 / float64(paperMm)))
	if ppi < 50 || ppi > 600 {
		ppi = 203
	}
	heightMM := int(math.Round(float64(heightDots) * 25.4 / float64(ppi)))
	if heightMM < 10 {
		heightMM = 10
	}
	if heightMM > 2000 {
		heightMM = 2000
	}
	return ppi, fmt.Sprintf("Custom.%dx%dmm", paperMm, heightMM), true
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
	if containsJob(active, spoolID) {
		// A disabled queue or a fault reason (paper out, offline) would otherwise
		// keep the till polling a job that cannot finish until the 30 s timeout.
		if queue, err := run(ctx, "lpstat", "-p", printer); err == nil {
			if code, detail := queueFault(queue); code != "" {
				return Status{State: "failed", Error: code, Detail: detail}, nil
			}
		}
		return Status{State: "printing"}, nil
	}
	// CUPS removes completed jobs from the short listing after a while. If the
	// job is no longer active, treat it as done rather than leaving the till
	// waiting forever; a failed job normally remains active with a reason.
	// (Polling `lpstat -W completed` only to ignore its answer was a wasted
	// subprocess on every finished job.)
	return Status{State: "done"}, nil
}

func (b *cupsBackend) Cancel(ctx context.Context, printer, spoolID string) error {
	if !ValidPrinterName(printer) || !spoolIDPattern.MatchString(spoolID) {
		return &Error{Code: "CANCEL_FAILED", Message: "invalid printer or job id"}
	}
	// OpenPrinting and Apple CUPS both reject `cancel -- <id>` ("unknown option
	// '-'"), so the validated id is passed directly. spoolIDPattern guarantees
	// it cannot be parsed as an option.
	if _, err := run(ctx, "cancel", spoolID); err != nil {
		return &Error{Code: "CANCEL_FAILED", Message: err.Error()}
	}
	return nil
}

// queueFault maps the textual `lpstat -p` state to the same codes the spooler
// status uses, so the until UI can say "load paper" instead of timing out.
// CUPS documents the reasons in free text ("printer X disabled since … - out of
// paper"), and localized output is avoided by the forced C locale in run().
func queueFault(out string) (code, detail string) {
	lower := strings.ToLower(out)
	detail = strings.TrimSpace(out)
	switch {
	case strings.Contains(lower, "out of paper"),
		strings.Contains(lower, "media-empty"),
		strings.Contains(lower, "paper-empty"),
		strings.Contains(lower, "media-jam"):
		return "PAPER_OUT", detail
	case strings.Contains(lower, "offline"),
		strings.Contains(lower, "off-line"),
		strings.Contains(lower, "disabled"):
		return "PRINTER_OFFLINE", detail
	}
	return "", ""
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

var (
	cupsEnvOnce  sync.Once
	cupsEnvCache []string
)

// The process environment does not change while the agent runs.
func cachedCupsEnv() []string {
	cupsEnvOnce.Do(func() { cupsEnvCache = cupsEnv(os.Environ()) })
	return cupsEnvCache
}

func run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = cachedCupsEnv()
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
