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
	// statusPollTTL coalesces the till's 100 ms status polls. A CUPS poll runs
	// one or two `lpstat` subprocesses; five polls per second per job was pure
	// process churn for a state the spooler updates far more slowly (L11).
	statusPollTTL = 200 * time.Millisecond
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
	// polledAt is the last completed backend status poll; polling is the
	// in-flight poll shared by every concurrent Get for this job (L11).
	polledAt time.Time
	polling  chan struct{}
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
	// in the Windows path left Linux/macOS open to decompression bombs. The
	// validated dimensions travel with the job so the backend does not decode
	// the header a second time (L11).
	imageWidth, imageHeight := 0, 0
	if req.Mode == "driver" {
		width, height, err := backend.ImageConfig(data)
		if err != nil {
			code, detail := backendError(err)
			m.update(rec, "failed", code, detail)
			return m.copy(rec), nil
		}
		imageWidth, imageHeight = width, height
	}
	unlock, err := m.lockPrinter(ctx, req.Printer)
	if err != nil {
		m.update(rec, "failed", "BUSY", "another job is still printing to this printer")
		return m.copy(rec), nil
	}
	defer unlock()
	// A cancel may have landed while this job was validating or waiting for the
	// printer. Do not spool a receipt the till already dropped; a cancel that
	// lands after this point is handled by the post-print spool-id check below.
	m.mu.Lock()
	cancelled := rec.Status == "canceled"
	m.mu.Unlock()
	if cancelled {
		return m.copy(rec), nil
	}
	copies := req.Copies
	if copies < 1 {
		copies = 1
	}
	printJob := &backend.Job{
		ID:          req.JobID,
		Printer:     req.Printer,
		Mode:        req.Mode,
		PaperMM:     req.PaperMM,
		WidthDots:   req.WidthDots,
		Copies:      copies,
		Encoding:    req.Encoding,
		Data:        data,
		ImageWidth:  imageWidth,
		ImageHeight: imageHeight,
	}
	// The backend owns the payload now. Dropping this reference means a driver
	// backend can nil its own copy after decoding and let the encoded PNG be
	// collected while the spooler runs (M17.3).
	data = nil
	spoolID, printErr := m.backend.Print(ctx, printJob)
	if printErr != nil {
		code, detail := backendError(printErr)
		m.update(rec, "failed", code, detail)
		return m.copy(rec), nil
	}
	m.mu.Lock()
	rec.spoolID = spoolID
	// A Cancel that landed while backend.Print was in flight saw no spool id and
	// could not stop the OS job. Now that the id exists, cancel it instead of
	// printing a receipt the till has already dropped.
	cancelSpool := spoolID != "" && rec.Status == "canceled"
	// Never overwrite a terminal status: only a job still "received" may move to
	// "spooled"/"done" once the backend returns.
	if !cancelSpool && rec.Status == "received" {
		if spoolID == "" {
			rec.Status = "done"
		} else {
			rec.Status = "spooled"
		}
	}
	rec.UpdatedAt = m.now().UnixMilli()
	current := rec
	if registered := m.jobs[req.JobID]; registered != nil {
		current = registered
	}
	status := current.JobStatus
	m.mu.Unlock()
	if cancelSpool {
		// The job record is already terminal; a failed OS cancel must not turn
		// the client's successful cancel into an error.
		cancelCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = m.backend.Cancel(cancelCtx, req.Printer, spoolID)
	}
	return &status, nil
}

// Get refreshes and returns a job's status. Terminal jobs are not polled again.
// Concurrent polls for one job share a single backend call, and a short cache
// absorbs the till's 100 ms polling cadence (L11).
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
	if rec.polling != nil {
		// Another request is already asking the OS. Wait for its answer instead
		// of spawning a second `lpstat`/GetJob for the same job.
		done := rec.polling
		m.mu.Unlock()
		select {
		case <-done:
		case <-ctx.Done():
		}
		return m.GetNoPoll(id)
	}
	printer, spoolID := rec.Printer, rec.spoolID
	if spoolID == "" && (rec.Status == "received" || rec.Status == "queued") {
		copy := rec.JobStatus
		m.mu.Unlock()
		return &copy, true
	}
	if !rec.polledAt.IsZero() &&
		m.now().Sub(rec.polledAt) < statusPollTTL {
		copy := rec.JobStatus
		m.mu.Unlock()
		return &copy, true
	}
	done := make(chan struct{})
	rec.polling = done
	m.mu.Unlock()

	var status backend.Status
	var err error
	defer func() {
		// Always release every waiter, even if a backend panics; otherwise the
		// record would stay "polling" and later Get calls would block forever.
		m.mu.Lock()
		rec.polledAt = m.now()
		if rec.polling == done {
			rec.polling = nil
		}
		m.mu.Unlock()
		close(done)
	}()

	status, err = m.backend.Status(ctx, printer, spoolID)
	m.mu.Lock()
	if err != nil {
		// A retry may have replaced the record while the spooler was polled, and
		// a cancel may have made this attempt terminal. Neither may receive the
		// stale poll's error detail.
		if current := m.jobs[id]; current == rec && !isTerminal(rec.Status) {
			rec.Detail = err.Error()
			rec.UpdatedAt = m.now().UnixMilli()
		}
		m.mu.Unlock()
		return m.GetNoPoll(id)
	}
	// A cancel that landed while the spooler was polled is terminal: do not
	// overwrite "canceled" with a spooler snapshot ("printing"/"done"). The
	// pointer check also keeps a retry's new attempt untouched.
	if current := m.jobs[id]; current == rec && !isTerminal(rec.Status) {
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

// Cancel asks the OS to cancel a job and records the result. A job that the
// backend has not spooled yet is marked canceled immediately; Submit cancels the
// OS job as soon as Print returns its spool id.
func (m *Manager) Cancel(ctx context.Context, id string) (*JobStatus, bool, error) {
	m.mu.Lock()
	rec := m.jobs[id]
	if rec == nil {
		m.mu.Unlock()
		return nil, false, nil
	}
	if isTerminal(rec.Status) {
		copy := rec.JobStatus
		m.mu.Unlock()
		return &copy, true, nil
	}
	printer, spoolID := rec.Printer, rec.spoolID
	if spoolID == "" {
		// The backend has not returned a spool id yet. Mark the record terminal here,
		// while the lock is held, so Submit observes `canceled` when Print returns and
		// can cancel the OS job. Unlocking first left a window where a job could be
		// reported canceled but still print.
		rec.Status = "canceled"
		rec.Error = ""
		rec.Detail = ""
		rec.UpdatedAt = m.now().UnixMilli()
		copy := rec.JobStatus
		m.mu.Unlock()
		return &copy, true, nil
	}
	m.mu.Unlock()

	if spoolID != "" {
		if err := m.backend.Cancel(ctx, printer, spoolID); err != nil {
			return nil, true, err
		}
	}
	m.mu.Lock()
	// Only the attempt that was cancelled becomes terminal. A retry Submit may
	// have replaced m.jobs[id] while backend.Cancel ran; marking the replacement
	// canceled would report a job canceled while its spooled receipt still
	// prints. The caller gets the record that is current now.
	if current := m.jobs[id]; current == rec && !isTerminal(rec.Status) {
		rec.Status = "canceled"
		rec.Error = ""
		rec.Detail = ""
		rec.UpdatedAt = m.now().UnixMilli()
	}
	current := m.jobs[id]
	if current == nil {
		current = rec
	}
	status := current.JobStatus
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

// update publishes a backend result on a job. It must not resurrect a terminal
// job (a cancel that landed first wins) and must not write to a record that a
// retry has already replaced.
func (m *Manager) update(rec *jobRecord, status, code, detail string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if isTerminal(rec.Status) || m.jobs[rec.JobID] != rec {
		return
	}
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
	// Pick the alphabet and padding from the text instead of running four
	// decoders and allocating an error on each failure (L11). The std and URL
	// alphabets only differ in +/ vs -_, so the choice is unambiguous.
	urlSafe := strings.ContainsAny(text, "-_")
	padded := strings.Contains(text, "=")
	var encoding *base64.Encoding
	switch {
	case urlSafe && padded:
		encoding = base64.URLEncoding
	case urlSafe:
		encoding = base64.RawURLEncoding
	case padded:
		encoding = base64.StdEncoding
	default:
		encoding = base64.RawStdEncoding
	}
	data, err := encoding.DecodeString(text)
	if err != nil {
		return nil, errors.New("data is not valid base64")
	}
	return data, nil
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
