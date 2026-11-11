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

	logger, closeLog := newLogger()
	defer closeLog()

	printBackend, err := backend.New()
	if err != nil {
		logger.Error("backend", "error", err)
		os.Exit(1)
	}
	auth := agent.NewAuth(cfg)
	jobs := agent.NewManager(printBackend)
	server := agent.NewServer(cfg, configPath, auth, jobs, printBackend, logger, version)

	addr := fmt.Sprintf("127.0.0.1:%d", cfg.Port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		logger.Error("listen", "address", addr, "error", err)
		os.Exit(1)
	}
	httpServer := &http.Server{
		Handler:           server.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	done := make(chan error, 1)
	go func() {
		done <- httpServer.Serve(listener)
	}()
	logger.Info("Bikri Print Agent started", "url", "http://"+addr, "config", configPath, "paired", cfg.Paired)
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
	}
}

func newLogger() (*slog.Logger, func()) {
	var writers []io.Writer
	writers = append(writers, os.Stderr)
	var file *os.File
	if dir, err := os.UserConfigDir(); err == nil {
		logDir := filepath.Join(dir, "bikri-print-agent")
		if err := os.MkdirAll(logDir, 0o700); err == nil {
			if f, err := os.OpenFile(filepath.Join(logDir, "agent.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
				file = f
				writers = append(writers, f)
			}
		}
	}
	handler := slog.NewJSONHandler(io.MultiWriter(writers...), &slog.HandlerOptions{Level: slog.LevelInfo})
	return slog.New(handler), func() {
		if file != nil {
			_ = file.Close()
		}
	}
}
