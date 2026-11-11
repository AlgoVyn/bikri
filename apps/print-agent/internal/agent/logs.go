package agent

import (
	"os"
	"path/filepath"
	"runtime"
)

// DefaultLogDir is a per-user, writable directory the installer can open from
// the Start Menu. It is deliberately outside the install directory on macOS so
// the logs survive app replacement.
func DefaultLogDir() string {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = os.TempDir()
		}
		return filepath.Join(base, "Bikri", "PrintAgent", "logs")
	case "darwin":
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Logs", "BikriPrintAgent")
		}
		return filepath.Join(os.TempDir(), "bikri-print-agent")
	default:
		if state := os.Getenv("XDG_STATE_HOME"); state != "" {
			return filepath.Join(state, "bikri-print-agent", "logs")
		}
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".local", "state", "bikri-print-agent", "logs")
		}
		return filepath.Join(os.TempDir(), "bikri-print-agent")
	}
}

// DefaultLogPath is the normal (non-crash) JSON log.
func DefaultLogPath() string { return filepath.Join(DefaultLogDir(), "agent.log") }

// CrashLogPath receives unhandled Go panics and fatal runtime errors, even when
// the GUI-subsystem build has no visible console.
func CrashLogPath() string { return filepath.Join(DefaultLogDir(), "crash.log") }
