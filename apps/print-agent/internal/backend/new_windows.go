//go:build windows

package backend

// New returns the Windows spooler backend.
func New() (Backend, error) { return &windowsBackend{}, nil }
