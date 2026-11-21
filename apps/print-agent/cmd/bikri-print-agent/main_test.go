package main

import (
	"os"
	"path/filepath"
	"testing"
)

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
