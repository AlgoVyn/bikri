//go:build !windows

package backend

// New returns the CUPS backend used by Linux and macOS.
func New() (Backend, error) { return &cupsBackend{}, nil }
