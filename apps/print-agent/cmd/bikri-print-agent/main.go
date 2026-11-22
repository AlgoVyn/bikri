// Command bikri-print-agent runs the loopback print service.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/algovyn/bikri/apps/print-agent/internal/agent"
	"github.com/algovyn/bikri/apps/print-agent/internal/backend"
)

// version is set with -ldflags "-X main.version=…" in release builds.
var version = "dev"

func main() {
	configFlag := flag.String("config", "", "path to config.json (default: user config directory)")
	portFlag := flag.Int("port", 0, "override the loopback port")
	allowOrigin := flag.String("allow-origin", "", "extra comma-separated CORS origin (development only)")
	versionFlag := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Println(version)
		return
	}

	configPath := *configFlag
	if configPath == "" {
		path, err := agent.DefaultPath()
		if err != nil {
			fmt.Fprintln(os.Stderr, "config path:", err)
			os.Exit(1)
		}
		configPath = path
	}
	cfg, err := agent.LoadConfig(configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load config:", err)
		os.Exit(1)
	}
	if *portFlag != 0 {
		if *portFlag < 1 || *portFlag > 65535 {
			fmt.Fprintln(os.Stderr, "port must be between 1 and 65535")
			os.Exit(1)
		}
		cfg.Port = *portFlag
	}
	for _, origin := range strings.Split(*allowOrigin, ",") {
		origin = strings.TrimSpace(origin)
		if origin != "" {
			// Development-only: kept in memory for this run, never persisted
			// into config.json (14 §7).
			cfg.TransientOrigins = append(cfg.TransientOrigins, origin)
		}
	}

	logPath := agent.DefaultLogPath()
	logger, closeLog := newLogger(logPath)
	defer closeLog()
	var crashLog *os.File
	// Append: systemd (Restart=on-failure) and launchd (KeepAlive) restart the
	// agent immediately after a panic, and O_TRUNC erased the stack trace of the
	// crash that caused the restart before anyone could read it. Cap it so a
	// restart loop cannot fill the disk (docs/14 §7).
	crashPath := agent.CrashLogPath()
	if info, err := os.Stat(crashPath); err == nil && info.Size() >= 2<<20 {
		_ = os.Remove(crashPath + ".1")
		_ = os.Rename(crashPath, crashPath+".1")
	}
	if crash, err := os.OpenFile(crashPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
		// Keep the file open for the process lifetime; the runtime writes to
		// this descriptor on a fatal error and does not own/close it.
		if err := debug.SetCrashOutput(crash, debug.CrashOptions{}); err == nil {
			crashLog = crash
		} else {
			_ = crash.Close()
		}
	}
	defer func() {
		if crashLog != nil {
			_ = crashLog.Close()
		}
	}()

	printBackend, err := backend.New()
	if err != nil {
		logger.Error("backend", "error", err)
		os.Exit(1)
	}
	auth := agent.NewAuth(cfg)
	jobs := agent.NewManager(printBackend)
	server := agent.NewServer(cfg, configPath, auth, jobs, printBackend, logger, version, logPath)

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		logger.Error("listen", "address", addr, "error", err)
		os.Exit(1)
	}
	httpServer := &http.Server{
		Handler:           server.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      45 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	done := make(chan error, 1)
	go func() {
		done <- httpServer.Serve(listener)
	}()
	logger.Info("Bikri Print Agent started", "url", "http://"+addr, "config", configPath, "log", logPath, "paired", cfg.Paired)
	if !cfg.Paired {
		logger.Info("pairing required", "open", "http://"+addr)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-done:
		if err != nil && err != http.ErrServerClosed {
			logger.Error("serve", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
		// Shutdown closes the listener, so Serve returns; wait for it instead of
		// letting main exit under a handler that is still flushing a response.
		select {
		case <-done:
		case <-shutdown.Done():
			logger.Warn("shutdown timed out waiting for the HTTP server")
		}
	}
}

func newLogger(logPath string) (*slog.Logger, func()) {
	var writers fanoutWriter
	var logFile *rotatingWriter
	logDir := filepath.Dir(logPath)
	if err := os.MkdirAll(logDir, 0o700); err == nil {
		// Keep one previous file; this is a diagnostic log, not an audit trail.
		// The writer rotates on write as well as at startup so a long-running
		// agent cannot grow agent.log without bound.
		if writer, err := newRotatingWriter(logPath, 5<<20); err == nil {
			logFile = writer
			// The file is the durable sink, so it is written first: a broken
			// console must not cost the line.
			writers = append(writers, writer)
		}
	}
	// A Windows -H=windowsgui binary has no console handle and every stderr
	// write fails; leaving it in the fan-out kept agent.log empty in production.
	if stderrUsable() {
		writers = append(writers, os.Stderr)
	}
	handler := slog.NewJSONHandler(writers, &slog.HandlerOptions{Level: slog.LevelInfo})
	return slog.New(handler), func() {
		if logFile != nil {
			_ = logFile.Close()
		}
	}
}

// stderrUsable reports whether os.Stderr is a real file handle. GUI-subsystem
// Windows builds and a closed Unix stderr pipe both fail this.
func stderrUsable() bool {
	_, err := os.Stderr.Stat()
	return err == nil
}

// fanoutWriter writes each log line to every sink and never stops early. io.MultiWriter
// aborts at the first error, which is exactly what hid every agent.log line when
// stderr was unusable.
type fanoutWriter []io.Writer

func (w fanoutWriter) Write(p []byte) (int, error) {
	for _, out := range w {
		_, _ = out.Write(p)
	}
	return len(p), nil
}

// rotatingWriter appends to a diagnostic log and rotates it once it reaches max
// bytes. Only one previous file is kept (`agent.log.1`).
type rotatingWriter struct {
	mu   sync.Mutex
	path string
	max  int64
	file *os.File
	size int64
	// After a transient open/rename failure, back off instead of turning every
	// log line into another failing syscall.
	retryAt  time.Time
	rotateAt time.Time
}

const (
	logReopenBackoff = 2 * time.Second
	logRotateBackoff = time.Minute
)

func newRotatingWriter(path string, max int64) (*rotatingWriter, error) {
	writer := &rotatingWriter{path: path, max: max}
	if err := writer.open(); err != nil {
		return nil, err
	}
	return writer, nil
}

func (w *rotatingWriter) open() error {
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	w.file = file
	w.size = info.Size()
	return nil
}

func (w *rotatingWriter) rotateLocked() {
	_ = w.file.Close()
	w.file = nil
	w.size = 0
	_ = os.Remove(w.path + ".1")
	if err := os.Rename(w.path, w.path+".1"); err != nil {
		// Windows AV/scanners can hold the log file and fail the rename. Keep
		// appending to the existing file instead of losing lines, and retry the
		// rotation later rather than on every write.
		w.rotateAt = time.Now().Add(logRotateBackoff)
		if openErr := w.open(); openErr != nil {
			w.retryAt = time.Now().Add(logReopenBackoff)
		}
		return
	}
	w.rotateAt = time.Time{}
	if err := w.open(); err != nil {
		w.retryAt = time.Now().Add(logReopenBackoff)
	}
}

func (w *rotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		now := time.Now()
		if now.Before(w.retryAt) {
			return 0, os.ErrClosed
		}
		if err := w.open(); err != nil {
			w.retryAt = now.Add(logReopenBackoff)
			return 0, err
		}
		w.retryAt = time.Time{}
	}
	// Rotate before the write that would cross the limit; a single oversized line
	// still lands in the fresh file instead of being dropped.
	if w.size > 0 && w.size+int64(len(p)) > w.max && time.Now().After(w.rotateAt) {
		w.rotateLocked()
		if w.file == nil {
			return 0, os.ErrClosed
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

func (w *rotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}
