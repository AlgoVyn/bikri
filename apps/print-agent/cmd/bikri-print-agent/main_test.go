package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
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
