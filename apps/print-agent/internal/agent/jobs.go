package agent

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/algovyn/bikri/apps/print-agent/internal/backend"
)

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
	ttl     time.Duration
	now     func() time.Time
}

// NewManager creates a job manager.
func NewManager(b backend.Backend) *Manager {
	return &Manager{
		backend: b,
		jobs:    map[string]*jobRecord{},
		ttl:     24 * time.Hour,
		now:     time.Now,
	}
}

// Submit validates, spools and records a job. A backend failure is stored on the
// job and returned in its status; the HTTP request itself succeeds so the client
// can show the printer error without guessing.
func (m *Manager) Submit(ctx context.Context, req JobRequest) (*JobStatus, error) {
	if err := validateRequest(req); err != nil {
		return nil, err
	}
	m.mu.Lock()
	if existing := m.jobs[req.JobID]; existing != nil {
		copy := existing.JobStatus
		m.mu.Unlock()
		return &copy, nil
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

	data, err := decodeData(req.Data)
	if err != nil {
		m.update(rec, "failed", "PAYLOAD_INVALID", err.Error())
		return m.copy(rec), nil
	}
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
	if rec.Status == "received" {
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
	if rec := m.jobs[id]; rec != nil {
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
	m.update(rec, "canceled", "", "")
	return m.copy(rec), true, nil
}

// Recent returns the most recent jobs for diagnostics, newest first.
func (m *Manager) Recent(limit int) []JobStatus {
	if limit < 1 {
		limit = 20
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]JobStatus, 0, limit)
	for _, rec := range m.jobs {
		out = append(out, rec.JobStatus)
	}
	// The map is unordered; a tiny insertion sort keeps diagnostics readable and
	// avoids importing sort for 20 rows.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].CreatedAt > out[j-1].CreatedAt; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
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
}

func validateRequest(req JobRequest) error {
	if strings.TrimSpace(req.JobID) == "" || len(req.JobID) > 80 {
		return errors.New("jobId is required (max 80 characters)")
	}
	if strings.TrimSpace(req.Printer) == "" {
		return errors.New("printer is required")
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
	if req.Data == "" {
		return errors.New("data is required")
	}
	return nil
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
