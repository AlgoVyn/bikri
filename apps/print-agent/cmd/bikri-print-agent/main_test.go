package main

import (
	"bytes"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type failingWriter struct{ calls int }

func (w *failingWriter) Write([]byte) (int, error) {
	w.calls++
	return 0, errors.New("no console")
}

func TestRotatingWriterRotatesWhileRunning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.log")
	writer, err := newRotatingWriter(path, 32)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = writer.Close() }()

	if _, err := writer.Write([]byte("12345678901234567890")); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("abcdefghij")); err != nil {
		t.Fatal(err)
	}
	// 30 + 3 bytes crosses the limit; the writer must rotate mid-process, not
	// only when the agent starts.
	if _, err := writer.Write([]byte("XYZ")); err != nil {
		t.Fatal(err)
	}

	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(current) != "XYZ" {
		t.Fatalf("current log = %q", current)
	}
	previous, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatal(err)
	}
	if string(previous) != "12345678901234567890abcdefghij" {
		t.Fatalf("previous log = %q", previous)
	}
}

// io.MultiWriter stops at the first failing writer, so a Windows GUI build with
// no console handle never reached agent.log. The fan-out must write the file
// first and ignore a broken console.
func TestFanoutWriterKeepsTheFileSinkWhenStderrFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.log")
	file, err := newRotatingWriter(path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = file.Close() }()
	console := &failingWriter{}
	line := []byte(`{"level":"INFO","msg":"print job"}` + "\n")
	n, err := fanoutWriter{file, console}.Write(line)
	if err != nil {
		t.Fatal(err)
	}
	if n != len(line) {
		t.Fatalf("wrote %d bytes, want %d", n, len(line))
	}
	if console.calls != 1 {
		t.Fatalf("console writes = %d", console.calls)
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, line) {
		t.Fatalf("agent.log = %q", stored)
	}
}

// A temporarily unopenable log used to make every later write fail with
// os.ErrClosed; the writer must try again instead of staying dead.
func TestRotatingWriterReopensAfterATransientFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.log")
	writer, err := newRotatingWriter(path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = writer.Close() }()
	if _, err := writer.Write([]byte("first\n")); err != nil {
		t.Fatal(err)
	}
	// Simulate a failed reopen (locked file, unmounted profile): the writer has
	// no descriptor and waits for the retry window.
	writer.mu.Lock()
	_ = writer.file.Close()
	writer.file = nil
	writer.retryAt = writer.retryAt.Add(-2 * logReopenBackoff)
	writer.mu.Unlock()
	if _, err := writer.Write([]byte("second\n")); err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != "first\nsecond\n" {
		t.Fatalf("agent.log = %q", stored)
	}
}

// A corrupt config.json used to exit through fmt.Fprintln(os.Stderr, …), which
// a Windows -H=windowsgui build does not have. The error must reach agent.log.
func TestStartupConfigErrorsReachTheLogFile(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "logs", "agent.log")
	logger, closeLog := newLogger(logPath)
	defer closeLog()
	configPath := filepath.Join(dir, "config.json")
	if err := os.WriteFile(configPath, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, gotPath, ok := startupConfig(logger, configPath, 0)
	if ok || cfg != nil || gotPath != "" {
		t.Fatalf("corrupt config was accepted: cfg=%+v path=%q ok=%v", cfg, gotPath, ok)
	}
	logged, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	// The JSON handler escapes Windows backslashes; compare the quoted path so the
	// assertion works on both C:\... and /tmp/... runners.
	if !bytes.Contains(logged, []byte("load config")) || !bytes.Contains(logged, []byte(strconv.Quote(configPath))) {
		t.Fatalf("agent.log does not contain the config error: %s", logged)
	}
}

func TestStartupConfigRejectsAnOutOfRangePort(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	configPath := filepath.Join(t.TempDir(), "config.json")
	for _, port := range []int{-1, 65536, 70000} {
		if _, _, ok := startupConfig(logger, configPath, port); ok {
			t.Fatalf("port %d was accepted", port)
		}
	}
	if !strings.Contains(logs.String(), "between 1 and 65535") {
		t.Fatalf("port errors were not logged: %s", logs.String())
	}
}

func TestStartupConfigAppliesThePortOverride(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	configPath := filepath.Join(t.TempDir(), "config.json")
	cfg, gotPath, ok := startupConfig(logger, configPath, 18500)
	if !ok || cfg == nil {
		t.Fatal("valid startup config was rejected")
	}
	if cfg.Port != 18500 {
		t.Fatalf("port = %d, want 18500", cfg.Port)
	}
	if gotPath != configPath {
		t.Fatalf("config path = %q, want %q", gotPath, configPath)
	}
}
