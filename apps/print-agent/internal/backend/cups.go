//go:build !windows

package backend

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// cupsBackend talks to CUPS with the standard command-line tools. It works on
// Linux and macOS and never needs root: the agent runs as the logged-in user and
// CUPS policy decides whether that user may print.
type cupsBackend struct{}

var requestIDPattern = regexp.MustCompile(`request id is (\S+)`)

func (b *cupsBackend) ListPrinters(ctx context.Context) ([]Printer, error) {
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
	if strings.TrimSpace(job.Printer) == "" {
		return "", &Error{Code: "UNKNOWN_PRINTER", Message: "no printer name"}
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
	}
	args = append(args, path)
	out, err := run(ctx, "lp", args...)
	if err != nil {
		return "", &Error{Code: "SPOOL_ERROR", Message: err.Error()}
	}
	if id := parseRequestID(out); id != "" {
		return id, nil
	}
	return job.ID, nil
}

func (b *cupsBackend) Status(ctx context.Context, printer, spoolID string) (Status, error) {
	if printer == "" {
		return Status{State: "failed", Error: "UNKNOWN_PRINTER"}, nil
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
	if printer == "" || spoolID == "" {
		return &Error{Code: "CANCEL_FAILED", Message: "missing printer or job id"}
	}
	if _, err := run(ctx, "cancel", spoolID); err != nil {
		return &Error{Code: "CANCEL_FAILED", Message: err.Error()}
	}
	return nil
}

func run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
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
