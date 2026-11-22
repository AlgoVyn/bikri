package agent

import (
	"context"
	"encoding/base64"
	"errors"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/algovyn/bikri/apps/print-agent/internal/backend"
)

const (
	maxJobs  = 100
	maxJobID = 80
)

var jobIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,80}$`)

// JobRequest is the JSON body of POST /v1/jobs.
type JobRequest struct {
	JobID     string `json:"jobId"`
	Printer   string `json:"printer"`
	Mode      string `json:"mode"`
	PaperMM   int    `json:"paperMm"`
	WidthDots int    `json:"widthDots"`
	Copies    int    `json:"copies"`
	Encoding  string `json:"encoding"`
	Data      string `json:"data"`
}

// JobStatus is the public state of one job.
type JobStatus struct {
	JobID     string `json:"jobId"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	Detail    string `json:"detail,omitempty"`
	Printer   string `json:"printer,omitempty"`
	Mode      string `json:"mode,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

type jobRecord struct {
	JobStatus
	spoolID string
}

// Manager keeps recent jobs in memory and delegates the OS work to a Backend.
// Bikri retries a lost job after an agent restart; receipts are never stored on
// disk by the agent.
type Manager struct {
	mu      sync.Mutex
	backend backend.Backend
	jobs    map[string]*jobRecord
	// One print at a time per queue, so two receipts cannot interleave their
	// raw bytes on the same spooler handle.
	printerLocks map[string]chan struct{}
	ttl          time.Duration
	now          func() time.Time
}

// NewManager creates a job manager.
func NewManager(b backend.Backend) *Manager {
	return &Manager{
		backend:      b,
		jobs:         map[string]*jobRecord{},
		printerLocks: map[string]chan struct{}{},
		ttl:          24 * time.Hour,
		now:          time.Now,
	}
}

func (m *Manager) lockPrinter(ctx context.Context, printer string) (func(), error) {
	m.mu.Lock()
	lock := m.printerLocks[printer]
	if lock == nil {
		lock = make(chan struct{}, 1)
		m.printerLocks[printer] = lock
	}
	m.mu.Unlock()
	select {
	case lock <- struct{}{}:
		return func() { <-lock }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Submit validates, spools and records a job. A backend failure is stored on the
// job and returned in its status; the HTTP request itself succeeds so the client
// can show the printer error without guessing. The caller's req.Data is cleared
// after decoding so the encoded payload can be collected while the printer runs.
func (m *Manager) Submit(ctx context.Context, req *JobRequest) (*JobStatus, error) {
	if req == nil {
		return nil, errors.New("request is required")
	}
	if err := validateRequest(*req); err != nil {
		return nil, err
	}
	m.mu.Lock()
	if existing := m.jobs[req.JobID]; existing != nil {
		// A finished job is truly idempotent; a failed or canceled job may be
		// retried with the same print-job id, so replace it and print again.
		if !isTerminal(existing.Status) || existing.Status == "done" {
			copy := existing.JobStatus
			m.mu.Unlock()
			return &copy, nil
		}
		delete(m.jobs, req.JobID)
	}
	m.cleanupLocked()
	now := m.now().UnixMilli()
	rec := &jobRecord{
		JobStatus: JobStatus{
			JobID:     req.JobID,
			Status:    "received",
			Printer:   req.Printer,
			Mode:      req.Mode,
			CreatedAt: now,
			UpdatedAt: now,
		},
	}
	m.jobs[req.JobID] = rec
	m.mu.Unlock()

	// Only print to a queue the agent has enumerated. A stale or hand-written client
	// could otherwise select any queue on the machine. Fail closed when enumeration
	// fails: passing an unvalidated name to `lp -d` is exactly the injection path.
	printers, err := m.backend.ListPrinters(ctx)
	if err != nil {
		m.update(rec, "failed", "SPOOL_ERROR", "the printer list is unavailable: "+err.Error())
		return m.copy(rec), nil
	}
	if !installedPrinter(printers, req.Printer) {
		m.update(rec, "failed", "UNKNOWN_PRINTER", "the printer is not installed")
		return m.copy(rec), nil
	}

	data, err := decodeData(req.Data)
	// The base64 text is the largest allocation in the request; drop this reference
	// before the printer runs instead of keeping it alive for the whole job.
	req.Data = ""
	if err != nil {
		m.update(rec, "failed", "PAYLOAD_INVALID", err.Error())
		return m.copy(rec), nil
	}
	// Driver mode sends a PNG to the OS driver. Check the IHDR centrally before
	// any backend decodes it: CUPS hands the file to a filter, so validating only
	// in the Windows path left Linux/macOS open to decompression bombs.
	if req.Mode == "driver" {
		if err := backend.ValidatePNG(data); err != nil {
			code, detail := backendError(err)
			m.update(rec, "failed", code, detail)
			return m.copy(rec), nil
		}
	}
	unlock, err := m.lockPrinter(ctx, req.Printer)
	if err != nil {
		m.update(rec, "failed", "BUSY", "another job is still printing to this printer")
		return m.copy(rec), nil
	}
	defer unlock()
	copies := req.Copies
	if copies < 1 {
		copies = 1
	}
	spoolID, printErr := m.backend.Print(ctx, backend.Job{
		ID:        req.JobID,
		Printer:   req.Printer,
		Mode:      req.Mode,
		PaperMM:   req.PaperMM,
		WidthDots: req.WidthDots,
		Copies:    copies,
		Encoding:  req.Encoding,
		Data:      data,
	})
	if printErr != nil {
		code, detail := backendError(printErr)
		m.update(rec, "failed", code, detail)
		return m.copy(rec), nil
	}
	m.mu.Lock()
	rec.spoolID = spoolID
	if spoolID == "" {
		// Driver-mode Windows and some CUPS queues finish synchronously and return
		// no spool id. There is nothing to poll; reporting "spooled" made the till
		// sleep 400 ms and then ask for a status that was already done. Do not
		// overwrite a concurrent Cancel's terminal state.
		if rec.Status == "received" {
			rec.Status = "done"
		}
	} else if rec.Status == "received" {
		rec.Status = "spooled"
	}
	rec.UpdatedAt = m.now().UnixMilli()
	m.mu.Unlock()
	return m.copy(rec), nil
}

// Get refreshes and returns a job's status. Terminal jobs are not polled again.
func (m *Manager) Get(ctx context.Context, id string) (*JobStatus, bool) {
	m.mu.Lock()
	rec := m.jobs[id]
	if rec == nil {
		m.mu.Unlock()
		return nil, false
	}
	if isTerminal(rec.Status) {
		copy := rec.JobStatus
		m.mu.Unlock()
		return &copy, true
	}
	printer, spoolID := rec.Printer, rec.spoolID
	if spoolID == "" && (rec.Status == "received" || rec.Status == "queued") {
		copy := rec.JobStatus
		m.mu.Unlock()
		return &copy, true
	}
	m.mu.Unlock()

	status, err := m.backend.Status(ctx, printer, spoolID)
	if err != nil {
		m.mu.Lock()
		if rec := m.jobs[id]; rec != nil {
			rec.Detail = err.Error()
			rec.UpdatedAt = m.now().UnixMilli()
		}
		m.mu.Unlock()
		return m.GetNoPoll(id)
	}
	m.mu.Lock()
	// A cancel that landed while the spooler was polled is terminal: do not
	// overwrite "canceled" with a spooler snapshot ("printing"/"done").
	if rec := m.jobs[id]; rec != nil && !isTerminal(rec.Status) {
		rec.Status = status.State
		rec.Error = status.Error
		rec.Detail = status.Detail
		rec.UpdatedAt = m.now().UnixMilli()
	}
	m.mu.Unlock()
	return m.GetNoPoll(id)
}

// GetNoPoll returns a stored job without contacting the OS.
func (m *Manager) GetNoPoll(id string) (*JobStatus, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := m.jobs[id]
	if rec == nil {
		return nil, false
	}
	copy := rec.JobStatus
	return &copy, true
}

// Cancel asks the OS to cancel a job and records the result.
func (m *Manager) Cancel(ctx context.Context, id string) (*JobStatus, bool, error) {
	m.mu.Lock()
	rec := m.jobs[id]
	if rec == nil {
		m.mu.Unlock()
		return nil, false, nil
	}
	printer, spoolID := rec.Printer, rec.spoolID
	if isTerminal(rec.Status) {
		copy := rec.JobStatus
		m.mu.Unlock()
		return &copy, true, nil
	}
	m.mu.Unlock()

	if err := m.backend.Cancel(ctx, printer, spoolID); err != nil {
		return nil, true, err
	}
	m.mu.Lock()
	if current := m.jobs[id]; current != nil && !isTerminal(current.Status) {
		current.Status = "canceled"
		current.Error = ""
		current.Detail = ""
		current.UpdatedAt = m.now().UnixMilli()
	}
	status := rec.JobStatus
	m.mu.Unlock()
	return &status, true, nil
}

// Recent returns the most recent jobs for diagnostics, newest first.
func (m *Manager) Recent(limit int) []JobStatus {
	if limit < 1 {
		limit = 20
	}
	m.mu.Lock()
	out := make([]JobStatus, 0, len(m.jobs))
	for _, rec := range m.jobs {
		out = append(out, rec.JobStatus)
	}
	m.mu.Unlock()
	// Sort outside the mutex: a busy shop keeps ~1,400 records for the 24 h TTL,
	// and holding m.mu through an O(n log n) sort blocked Submit/Get (D-231).
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt > out[j].CreatedAt
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (m *Manager) update(rec *jobRecord, status, code, detail string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec.Status = status
	rec.Error = code
	rec.Detail = detail
	rec.UpdatedAt = m.now().UnixMilli()
}

func (m *Manager) copy(rec *jobRecord) *JobStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := rec.JobStatus
	return &out
}

func (m *Manager) cleanupLocked() {
	cutoff := m.now().Add(-m.ttl).UnixMilli()
	for id, rec := range m.jobs {
		if rec.CreatedAt < cutoff {
			delete(m.jobs, id)
		}
	}
	// Keep memory and the diagnostics list bounded even on a busy day (100 jobs
	// per docs/14 §7). Evict only terminal jobs; an active job must stay pollable.
	for len(m.jobs) > maxJobs {
		var oldestID string
		var oldestAt int64
		for id, rec := range m.jobs {
			if !isTerminal(rec.Status) {
				continue
			}
			if oldestID == "" || rec.CreatedAt < oldestAt {
				oldestID, oldestAt = id, rec.CreatedAt
			}
		}
		if oldestID == "" {
			break
		}
		delete(m.jobs, oldestID)
	}
}

func validateRequest(req JobRequest) error {
	if !jobIDPattern.MatchString(req.JobID) || len(req.JobID) > maxJobID {
		return errors.New("jobId must be 1-80 letters, digits, dot, underscore or hyphen")
	}
	if strings.TrimSpace(req.Printer) == "" {
		return errors.New("printer is required")
	}
	if !backend.ValidPrinterName(req.Printer) {
		return errors.New("printer contains invalid characters")
	}
	if req.Mode != "raw" && req.Mode != "driver" {
		return errors.New(`mode must be "raw" or "driver"`)
	}
	if req.Mode == "raw" && req.Encoding != "escpos" {
		return errors.New(`raw jobs need encoding="escpos"`)
	}
	if req.Mode == "driver" && req.Encoding != "png" {
		return errors.New(`driver jobs need encoding="png"`)
	}
	if req.PaperMM != 0 && req.PaperMM != 58 && req.PaperMM != 80 {
		return errors.New("paperMm must be 58 or 80")
	}
	if req.WidthDots < 0 || req.WidthDots > 2048 {
		return errors.New("widthDots is out of range")
	}
	if req.Copies < 0 || req.Copies > 3 {
		return errors.New("copies must be 0-3")
	}
	if strings.TrimSpace(req.Data) == "" {
		return errors.New("data is required")
	}
	return nil
}

func installedPrinter(printers []backend.Printer, name string) bool {
	for _, printer := range printers {
		if printer.Name == name {
			return true
		}
	}
	return false
}

func decodeData(text string) ([]byte, error) {
	encodings := []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	}
	for _, enc := range encodings {
		if data, err := enc.DecodeString(text); err == nil {
			return data, nil
		}
	}
	return nil, errors.New("data is not valid base64")
}

func backendError(err error) (code, detail string) {
	var be *backend.Error
	if errors.As(err, &be) {
		return be.Code, be.Message
	}
	return "SPOOL_ERROR", err.Error()
}

func isTerminal(status string) bool {
	return status == "done" || status == "failed" || status == "canceled"
}
