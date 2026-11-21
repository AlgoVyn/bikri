//go:build windows

package backend

// New returns the Windows spooler backend.
func New() (Backend, error) {
	return &windowsBackend{
		rawUnsupported: map[string]bool{},
		rawSupported:   map[string]bool{},
	}, nil
}
