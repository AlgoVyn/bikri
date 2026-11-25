package agent

import (
	"context"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"errors"
	"html/template"
	"log/slog"
	"net"
	"net/http"
	"net/url"
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
	// Per-process CSRF nonce for the local unpair form. A cross-origin page can
	// neither read this page nor guess the nonce.
	csrfToken string
	limits    *rateLimiter
}

// NewServer wires the agent dependencies.
func NewServer(cfg *Config, cfgPath string, auth *Auth, jobs *Manager, b backend.Backend, log *slog.Logger, version, logPath string) *Server {
	return &Server{
		cfg:       cfg,
		cfgPath:   cfgPath,
		auth:      auth,
		jobs:      jobs,
		backend:   b,
		log:       log,
		version:   version,
		logPath:   logPath,
		started:   time.Now(),
		csrfToken: randomID(),
		limits:    newRateLimiter(time.Minute),
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
		if !s.validHost(r) {
			writeError(w, http.StatusForbidden, "FORBIDDEN_HOST", "invalid Host header")
			return
		}
		origin := r.Header.Get("Origin")
		api := strings.HasPrefix(r.URL.Path, "/v1/")
		if !api {
			// The local page is not a CORS resource. It carries the CSRF nonce,
			// the printer list and the log path, so a script on an allowed API
			// origin must not be able to read it. Only the loopback page itself
			// may send a non-empty Origin here, and no CORS header is ever
			// emitted.
			if origin != "" && !sameLoopbackOrigin(origin, r.Host) {
				writeError(w, http.StatusForbidden, "FORBIDDEN_ORIGIN", "origin is not allowed")
				return
			}
		} else {
			if origin != "" && !s.allowedOrigin(origin, r.Host) {
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
			w.Header().Set("Content-Type", "application/json")
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowedOrigin(origin, host string) bool {
	// The local page itself is same-origin with the request Host. The listener
	// only binds a loopback address and validHost already rejected anything else.
	if strings.EqualFold(origin, "http://"+host) {
		return true
	}
	if origin == "http://127.0.0.1:"+strconv.Itoa(s.cfg.Port) ||
		origin == "http://localhost:"+strconv.Itoa(s.cfg.Port) {
		return true
	}
	for _, allowed := range s.cfg.Origins {
		if origin == allowed {
			return true
		}
	}
	// --allow-origin values are for this run only and are never persisted.
	for _, allowed := range s.cfg.TransientOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}

// validHost accepts only a loopback host on the port this server is actually
// listening on (14 §7). Discarding the port let a DNS-rebinding page reach the
// agent through any other local port; the request context carries the bound
// address, so tests and an overridden -port both keep working.
func (s *Server) validHost(r *http.Request) bool {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil {
		return false
	}
	if host != "127.0.0.1" && host != "localhost" && host != "::1" && host != "[::1]" {
		return false
	}
	expected := strconv.Itoa(s.cfg.Port)
	if local, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
		if _, localPort, err := net.SplitHostPort(local.String()); err == nil {
			expected = localPort
		}
	}
	return port == expected
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

func requestToken(r *http.Request) string {
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return hashToken(strings.TrimSpace(token))
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
	if !s.limits.allow("pair:"+remoteIP(r.RemoteAddr), 5) {
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many pairing attempts; try again in a minute")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	var body struct {
		Code       string `json:"code"`
		ClientName string `json:"clientName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		if tooLarge(w, err) {
			return
		}
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body")
		return
	}
	token, err := s.auth.PairAndPersist(s.cfgPath, strings.TrimSpace(body.Code))
	if err != nil {
		switch {
		case errors.Is(err, errAlreadyPaired):
			writeError(w, http.StatusConflict, "ALREADY_PAIRED", "this agent is already paired")
		case errors.Is(err, errTooManyTries):
			writeError(w, http.StatusTooManyRequests, "TOO_MANY_ATTEMPTS", "too many pairing attempts")
		case errors.Is(err, errBadCode):
			writeError(w, http.StatusUnauthorized, "PAIRING_CODE", "the pairing code is wrong or expired")
		default:
			// The token was rolled back with the failed write, so the agent stays
			// unpaired and the code remains usable.
			writeError(w, http.StatusInternalServerError, "CONFIG_ERROR", err.Error())
		}
		return
	}
	s.log.Info("agent paired", "client", body.ClientName)
	writeJSON(w, http.StatusOK, map[string]string{
		"token":   token,
		"agentId": s.cfg.AgentID,
	})
}

func (s *Server) unpair(w http.ResponseWriter, r *http.Request) {
	if err := s.auth.UnpairAndPersist(s.cfgPath); err != nil {
		writeError(w, http.StatusInternalServerError, "CONFIG_ERROR", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// uiUnpair is the local status page's reset action. It is intentionally
// loopback-only (the security middleware checks Host and Origin) so a user who
// lost the Bikri-side token can pair the till again.
func (s *Server) uiUnpair(w http.ResponseWriter, r *http.Request) {
	if !s.validUIAction(w, r) {
		return
	}
	if err := s.auth.UnpairAndPersist(s.cfgPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// validUIAction ties the local reset form to this page load: the request must
// come from a loopback origin, be a same-origin browser navigation, and carry
// the per-process nonce rendered in the form. Without all three, a page on an
// allowed API origin could unpair the agent and hijack the fresh pairing code.
func (s *Server) validUIAction(w http.ResponseWriter, r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		http.Error(w, "cross-site request refused", http.StatusForbidden)
		return false
	}
	if !sameLoopbackOrigin(r.Header.Get("Origin"), r.Host) {
		http.Error(w, "invalid origin", http.StatusForbidden)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := r.ParseForm(); err != nil {
		if bodyTooLarge(err) {
			http.Error(w, "request body is too large", http.StatusRequestEntityTooLarge)
			return false
		}
		http.Error(w, "invalid form", http.StatusBadRequest)
		return false
	}
	nonce := r.PostFormValue("csrf")
	if subtle.ConstantTimeCompare([]byte(nonce), []byte(s.csrfToken)) != 1 {
		http.Error(w, "invalid request token", http.StatusForbidden)
		return false
	}
	return true
}

func sameLoopbackOrigin(origin, host string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme != "http" || !strings.EqualFold(parsed.Host, host) {
		return false
	}
	name, _, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		return false
	}
	return name == "127.0.0.1" || name == "localhost" || name == "::1"
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
	if list == nil {
		list = []backend.Printer{}
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	if !s.limits.allow("jobs:"+requestToken(r), 60) {
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many print jobs; try again in a minute")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
	var req JobRequest
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&req); err != nil {
		if tooLarge(w, err) {
			return
		}
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "invalid JSON body: "+err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	job, err := s.jobs.Submit(ctx, &req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	s.log.Info("print job", "job", job.JobID, "printer", job.Printer, "mode", job.Mode, "status", job.Status, "error", job.Error)
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) job(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	job, ok := s.jobs.Get(ctx, r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "job not found")
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) cancel(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	job, found, err := s.jobs.Cancel(ctx, r.PathValue("id"))
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
	if !s.limits.allow("diagnostics:"+requestToken(r), 10) {
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many diagnostics requests; try again in a minute")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	list, _ := s.backend.ListPrinters(ctx)
	if list == nil {
		list = []backend.Printer{}
	}
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
	CSRF         string
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
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("X-Frame-Options", "DENY")
	data := uiData{
		Paired:       s.auth.Paired(),
		CSRF:         s.csrfToken,
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

// bodyTooLarge reports a MaxBytesReader rejection.
func bodyTooLarge(err error) bool {
	var max *http.MaxBytesError
	return errors.As(err, &max)
}

// tooLarge writes the 413 the API documents (14 §6 lists PAYLOAD_TOO_LARGE)
// instead of the generic 400 a decoder error would produce.
func tooLarge(w http.ResponseWriter, err error) bool {
	if !bodyTooLarge(err) {
		return false
	}
	writeError(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "the request body is too large")
	return true
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": message})
}

func platformName() string {
	return platformOS() + "/" + platformArch()
}
