package agent

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"html/template"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/algovyn/bikri/apps/print-agent/internal/backend"
)

//go:embed ui.html
var uiFiles embed.FS

var uiTemplate = template.Must(template.ParseFS(uiFiles, "ui.html"))

// Server is the loopback HTTP API and its local status page.
type Server struct {
	cfg     *Config
	cfgPath string
	auth    *Auth
	jobs    *Manager
	backend backend.Backend
	log     *slog.Logger
	version string
	logPath string
	started time.Time
}

// NewServer wires the agent dependencies.
func NewServer(cfg *Config, cfgPath string, auth *Auth, jobs *Manager, b backend.Backend, log *slog.Logger, version, logPath string) *Server {
	return &Server{
		cfg:     cfg,
		cfgPath: cfgPath,
		auth:    auth,
		jobs:    jobs,
		backend: b,
		log:     log,
		version: version,
		logPath: logPath,
		started: time.Now(),
	}
}

// Handler returns the complete HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.ui)
	mux.HandleFunc("POST /ui/unpair", s.uiUnpair)
	mux.HandleFunc("GET /v1/health", s.health)
	mux.HandleFunc("POST /v1/pair", s.pair)
	mux.HandleFunc("POST /v1/unpair", s.requireAuth(s.unpair))
	mux.HandleFunc("GET /v1/printers", s.requireAuth(s.printers))
	mux.HandleFunc("POST /v1/jobs", s.requireAuth(s.submit))
	mux.HandleFunc("GET /v1/jobs/{id}", s.requireAuth(s.job))
	mux.HandleFunc("DELETE /v1/jobs/{id}", s.requireAuth(s.cancel))
	mux.HandleFunc("GET /v1/diagnostics", s.requireAuth(s.diagnostics))
	return s.security(mux)
}

func (s *Server) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if value := recover(); value != nil {
				s.log.Error("panic", "value", value, "stack", string(debug.Stack()))
				writeError(w, http.StatusInternalServerError, "INTERNAL", "the print service hit an internal error")
			}
		}()
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		if !validHost(r.Host) {
			writeError(w, http.StatusForbidden, "FORBIDDEN_HOST", "invalid Host header")
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" && !s.allowedOrigin(origin) {
			writeError(w, http.StatusForbidden, "FORBIDDEN_ORIGIN", "origin is not allowed")
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			w.Header().Set("Content-Type", "application/json")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowedOrigin(origin string) bool {
	if origin == "http://127.0.0.1:"+strconv.Itoa(s.cfg.Port) ||
		origin == "http://localhost:"+strconv.Itoa(s.cfg.Port) {
		return true
	}
	for _, allowed := range s.cfg.Origins {
		if origin == allowed {
			return true
		}
	}
	return false
}

func validHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	return host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
}

func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(header, "Bearer ")
		if !ok || !s.auth.Verify(strings.TrimSpace(token)) {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "a valid bearer token is required")
			return
		}
		next(w, r)
	}
}

type healthResponse struct {
	App         string `json:"app"`
	Version     string `json:"version"`
	Protocol    int    `json:"protocol"`
	Platform    string `json:"platform"`
	Paired      bool   `json:"paired"`
	Printers    int    `json:"printers"`
	PairingCode string `json:"pairingCode,omitempty"`
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	// Health must answer even when a slow Windows printer enumeration is still
	// running; the wizard has a short timeout and only needs the pairing state.
	ctx, cancel := context.WithTimeout(r.Context(), 300*time.Millisecond)
	defer cancel()
	printers := 0
	if list, err := s.backend.ListPrinters(ctx); err == nil {
		printers = len(list)
	}
	writeJSON(w, http.StatusOK, healthResponse{
		App:         "bikri-print-agent",
		Version:     s.version,
		Protocol:    Protocol,
		Platform:    platformName(),
		Paired:      s.auth.Paired(),
		Printers:    printers,
		PairingCode: s.auth.PairingCode(),
	})
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var body struct {
		Code       string `json:"code"`
		ClientName string `json:"clientName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body")
		return
	}
	token, err := s.auth.Pair(strings.TrimSpace(body.Code))
	if err != nil {
		switch {
		case errors.Is(err, errAlreadyPaired):
			writeError(w, http.StatusConflict, "ALREADY_PAIRED", "this agent is already paired")
		case errors.Is(err, errTooManyTries):
			writeError(w, http.StatusTooManyRequests, "TOO_MANY_ATTEMPTS", "too many pairing attempts")
		default:
			writeError(w, http.StatusUnauthorized, "PAIRING_CODE", "the pairing code is wrong or expired")
		}
		return
	}
	if err := s.auth.Persist(s.cfgPath); err != nil {
		s.auth.Unpair()
		writeError(w, http.StatusInternalServerError, "CONFIG_ERROR", err.Error())
		return
	}
	s.log.Info("agent paired", "client", body.ClientName)
	writeJSON(w, http.StatusOK, map[string]string{
		"token":   token,
		"agentId": s.cfg.AgentID,
	})
}

func (s *Server) unpair(w http.ResponseWriter, r *http.Request) {
	s.auth.Unpair()
	if err := s.auth.Persist(s.cfgPath); err != nil {
		writeError(w, http.StatusInternalServerError, "CONFIG_ERROR", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// uiUnpair is the local status page's reset action. It is intentionally
// loopback-only (the security middleware checks Host and Origin) so a user who
// lost the Bikri-side token can pair the till again.
func (s *Server) uiUnpair(w http.ResponseWriter, r *http.Request) {
	s.auth.Unpair()
	if err := s.auth.Persist(s.cfgPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *Server) printers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	list, err := s.backend.ListPrinters(ctx)
	if err != nil {
		code, detail := backendError(err)
		writeError(w, http.StatusBadGateway, code, detail)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
	var req JobRequest
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body: "+err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	job, err := s.jobs.Submit(ctx, req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	s.log.Info("print job", "job", job.JobID, "printer", job.Printer, "mode", job.Mode, "status", job.Status, "error", job.Error)
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) job(w http.ResponseWriter, r *http.Request) {
	job, ok := s.jobs.Get(r.Context(), r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "job not found")
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) cancel(w http.ResponseWriter, r *http.Request) {
	job, found, err := s.jobs.Cancel(r.Context(), r.PathValue("id"))
	if !found {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "job not found")
		return
	}
	if err != nil {
		code, detail := backendError(err)
		writeError(w, http.StatusBadGateway, code, detail)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

type diagnostics struct {
	App       string            `json:"app"`
	Version   string            `json:"version"`
	Protocol  int               `json:"protocol"`
	Platform  string            `json:"platform"`
	AgentID   string            `json:"agentId"`
	Paired    bool              `json:"paired"`
	LogPath   string            `json:"logPath,omitempty"`
	UptimeSec int64             `json:"uptimeSeconds"`
	Printers  []backend.Printer `json:"printers"`
	Jobs      []JobStatus       `json:"recentJobs"`
}

func (s *Server) diagnostics(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	list, _ := s.backend.ListPrinters(ctx)
	writeJSON(w, http.StatusOK, diagnostics{
		App:       "bikri-print-agent",
		Version:   s.version,
		Protocol:  Protocol,
		Platform:  platformName(),
		AgentID:   s.cfg.AgentID,
		Paired:    s.auth.Paired(),
		LogPath:   s.logPath,
		UptimeSec: int64(time.Since(s.started).Seconds()),
		Printers:  list,
		Jobs:      s.jobs.Recent(20),
	})
}

type uiData struct {
	Paired       bool
	Code         string
	Version      string
	Protocol     int
	Platform     string
	LogPath      string
	Printers     []backend.Printer
	PrinterError string
}

func (s *Server) ui(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	list, err := s.backend.ListPrinters(ctx)
	printerErr := ""
	if err != nil {
		printerErr = err.Error()
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Frame-Options", "DENY")
	data := uiData{
		Paired:       s.auth.Paired(),
		Code:         s.auth.PairingCode(),
		Version:      s.version,
		Protocol:     Protocol,
		Platform:     platformName(),
		LogPath:      s.logPath,
		Printers:     list,
		PrinterError: printerErr,
	}
	if err := uiTemplate.Execute(w, data); err != nil {
		s.log.Error("ui render", "error", err)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": message})
}

func platformName() string {
	return platformOS() + "/" + platformArch()
}
