package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/png"
	"sync"
	"testing"
	"time"

	"github.com/algovyn/bikri/apps/print-agent/internal/backend"
)

type fakeBackend struct {
	mu          sync.Mutex
	printCalls  int
	inFlight    int
	maxInFlight int
	printDelay  time.Duration
	printErr    error
	spoolID     string
	status      backend.Status
	statusErr   error
	statusCalls int
	statusHook  func()
	cancelErr   error
	cancelCalls int
	canceledIDs []string
	printers    []backend.Printer
	printersErr error
	lastJob     backend.Job

	// Channels let a test interleave Cancel/Submit/Get deterministically.
	printEntered  chan struct{}
	printRelease  chan struct{}
	cancelEntered chan struct{}
	cancelRelease chan struct{}
}

func (f *fakeBackend) ListPrinters(context.Context) ([]backend.Printer, error) {
	if f.printersErr != nil {
		return nil, f.printersErr
	}
	if f.printers == nil {
		return []backend.Printer{{Name: "Bixolon", IsDefault: true}}, nil
	}
	return f.printers, nil
}

func (f *fakeBackend) Print(_ context.Context, job *backend.Job) (string, error) {
	f.mu.Lock()
	f.printCalls++
	f.inFlight++
	if f.inFlight > f.maxInFlight {
		f.maxInFlight = f.inFlight
	}
	if job != nil {
		f.lastJob = *job
	}
	delay := f.printDelay
	printErr := f.printErr
	spoolID := f.spoolID
	entered, release := f.printEntered, f.printRelease
	f.mu.Unlock()
	if entered != nil {
		close(entered)
	}
	if release != nil {
		<-release
	}
	if delay > 0 {
		time.Sleep(delay)
	}
	f.mu.Lock()
	f.inFlight--
	f.mu.Unlock()
	if printErr != nil {
		return "", printErr
	}
	return spoolID, nil
}

func (f *fakeBackend) Status(context.Context, string, string) (backend.Status, error) {
	f.mu.Lock()
	f.statusCalls++
	hook := f.statusHook
	status, err := f.status, f.statusErr
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	return status, err
}

func (f *fakeBackend) Cancel(_ context.Context, _ string, spoolID string) error {
	f.mu.Lock()
	f.cancelCalls++
	f.canceledIDs = append(f.canceledIDs, spoolID)
	err := f.cancelErr
	entered, release := f.cancelEntered, f.cancelRelease
	f.mu.Unlock()
	if entered != nil {
		close(entered)
	}
	if release != nil {
		<-release
	}
	return err
}

func validRequest() JobRequest {
	return JobRequest{
		JobID:    "job-1",
		Printer:  "Bixolon",
		Mode:     "raw",
		PaperMM:  80,
		Copies:   1,
		Encoding: "escpos",
		Data:     "G0Bh",
	}
}

// submitJob keeps the table-style tests on a value while exercising the
// ownership-taking Submit used by the HTTP handler.
func submitJob(manager *Manager, req JobRequest) (*JobStatus, error) {
	return manager.Submit(context.Background(), &req)
}

func TestManagerMarksSynchronousPrintDone(t *testing.T) {
	// Driver-mode Windows (and CUPS without a request id) return no spool id after
	// the document has already been accepted; the till must not poll and wait.
	fake := &fakeBackend{spoolID: ""}
	manager := NewManager(fake)
	job, err := submitJob(manager, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != "done" {
		t.Fatalf("job = %+v", job)
	}
}

func TestManagerClearsPayloadAfterDecode(t *testing.T) {
	manager := NewManager(&fakeBackend{spoolID: "42"})
	req := validRequest()
	if _, err := manager.Submit(context.Background(), &req); err != nil {
		t.Fatal(err)
	}
	if req.Data != "" {
		t.Fatalf("encoded payload = %q, want it cleared", req.Data)
	}
}

// The manager validates the PNG header once and hands the dimensions to the
// backend, so CUPS/GDI do not decode the same IHDR again (L11).
func TestManagerPassesValidatedPNGDimensions(t *testing.T) {
	var encoded bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 7, 5))
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	fake := &fakeBackend{spoolID: "42"}
	manager := NewManager(fake)
	req := validRequest()
	req.Mode = "driver"
	req.Encoding = "png"
	req.Data = base64.StdEncoding.EncodeToString(encoded.Bytes())
	if _, err := submitJob(manager, req); err != nil {
		t.Fatal(err)
	}
	if fake.lastJob.ImageWidth != 7 || fake.lastJob.ImageHeight != 5 {
		t.Fatalf("job dimensions = %dx%d, want 7x5", fake.lastJob.ImageWidth, fake.lastJob.ImageHeight)
	}
}

func TestDecodeDataDetectsTheAlphabet(t *testing.T) {
	payload := []byte{0xfb, 0xff, 0x00, 0x01}
	for name, text := range map[string]string{
		"std padded":     base64.StdEncoding.EncodeToString(payload),
		"std raw":        base64.RawStdEncoding.EncodeToString(payload),
		"url padded":     base64.URLEncoding.EncodeToString(payload),
		"url raw":        base64.RawURLEncoding.EncodeToString(payload),
		"plain alphabet": "G0Bh",
	} {
		got, err := decodeData(text)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if name != "plain alphabet" && !bytes.Equal(got, payload) {
			t.Fatalf("%s = %x, want %x", name, got, payload)
		}
	}
	for _, text := range []string{"not base64!", "====", "G0Bh$"} {
		if _, err := decodeData(text); err == nil {
			t.Fatalf("invalid base64 accepted: %q", text)
		}
	}
}

// The till polls every 100 ms. A CUPS poll spawns `lpstat`, so concurrent gets
// share one backend call and a short cache absorbs the polling cadence (L11).
func TestManagerGetSingleflightsAndCachesStatusPolls(t *testing.T) {
	fake := &fakeBackend{spoolID: "7", status: backend.Status{State: "printing"}}
	manager := NewManager(fake)
	base := time.Now()
	manager.now = func() time.Time { return base }
	if _, err := submitJob(manager, validRequest()); err != nil {
		t.Fatal(err)
	}
	first, ok := manager.Get(context.Background(), "job-1")
	if !ok || first.Status != "printing" {
		t.Fatalf("first poll = %+v, ok = %v", first, ok)
	}
	if fake.statusCalls != 1 {
		t.Fatalf("status calls = %d, want 1", fake.statusCalls)
	}
	// Inside the cache window the stored snapshot is returned.
	if _, ok := manager.Get(context.Background(), "job-1"); !ok {
		t.Fatal("cached get failed")
	}
	if fake.statusCalls != 1 {
		t.Fatalf("cached get polled again: %d calls", fake.statusCalls)
	}
	// After the window the spooler is asked again.
	base = base.Add(statusPollTTL + time.Millisecond)
	if _, ok := manager.Get(context.Background(), "job-1"); !ok {
		t.Fatal("post-cache get failed")
	}
	if fake.statusCalls != 2 {
		t.Fatalf("expired cache did not poll: %d calls", fake.statusCalls)
	}
}

func TestManagerGetSharesAnInFlightPoll(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	fake := &fakeBackend{spoolID: "7", status: backend.Status{State: "printing"}}
	fake.statusHook = func() {
		once.Do(func() { close(entered) })
		<-release
	}
	manager := NewManager(fake)
	if _, err := submitJob(manager, validRequest()); err != nil {
		t.Fatal(err)
	}
	first := make(chan *JobStatus, 1)
	go func() {
		job, _ := manager.Get(context.Background(), "job-1")
		first <- job
	}()
	<-entered
	second := make(chan *JobStatus, 1)
	go func() {
		job, _ := manager.Get(context.Background(), "job-1")
		second <- job
	}()
	// Let the second Get observe the in-flight poll.
	time.Sleep(20 * time.Millisecond)
	fake.mu.Lock()
	calls := fake.statusCalls
	fake.mu.Unlock()
	if calls != 1 {
		close(release)
		t.Fatalf("concurrent poll spawned %d status calls, want 1", calls)
	}
	close(release)
	for _, ch := range []chan *JobStatus{first, second} {
		if job := <-ch; job == nil || job.Status != "printing" {
			t.Fatalf("polled job = %+v", job)
		}
	}
	fake.mu.Lock()
	calls = fake.statusCalls
	fake.mu.Unlock()
	if calls != 1 {
		t.Fatalf("waiter polled again: %d calls", calls)
	}
}

func TestManagerSubmitIsIdempotent(t *testing.T) {
	fake := &fakeBackend{spoolID: "42", status: backend.Status{State: "done"}}
	manager := NewManager(fake)
	first, err := submitJob(manager, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "spooled" {
		t.Fatalf("status = %s", first.Status)
	}
	second, err := submitJob(manager, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if second.Status != "spooled" {
		t.Fatalf("duplicate status = %s", second.Status)
	}
	if fake.printCalls != 1 {
		t.Fatalf("duplicate job printed %d times", fake.printCalls)
	}
	done, ok := manager.Get(context.Background(), "job-1")
	if !ok || done.Status != "done" {
		t.Fatalf("done = %+v, ok = %v", done, ok)
	}
}

func TestManagerStoresBackendFailure(t *testing.T) {
	fake := &fakeBackend{printErr: &backend.Error{Code: "RAW_UNSUPPORTED", Message: "no raw"}}
	manager := NewManager(fake)
	job, err := submitJob(manager, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != "failed" || job.Error != "RAW_UNSUPPORTED" {
		t.Fatalf("job = %+v", job)
	}
}

func TestManagerRejectsUnknownPrinter(t *testing.T) {
	fake := &fakeBackend{
		spoolID:  "42",
		printers: []backend.Printer{{Name: "Office"}},
	}
	manager := NewManager(fake)
	job, err := submitJob(manager, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != "failed" || job.Error != "UNKNOWN_PRINTER" {
		t.Fatalf("job = %+v", job)
	}
	if fake.printCalls != 0 {
		t.Fatalf("unknown printer printed %d times", fake.printCalls)
	}
}

func TestManagerFailsClosedWhenEnumerationFails(t *testing.T) {
	fake := &fakeBackend{
		spoolID:     "42",
		printersErr: errors.New("cups unavailable"),
	}
	manager := NewManager(fake)
	job, err := submitJob(manager, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != "failed" || job.Error != "SPOOL_ERROR" {
		t.Fatalf("job = %+v", job)
	}
	if fake.printCalls != 0 {
		t.Fatalf("unvalidated printer was printed %d times", fake.printCalls)
	}
}

func TestManagerValidatesJobIDAndPrinter(t *testing.T) {
	manager := NewManager(&fakeBackend{spoolID: "42"})
	for _, update := range []func(*JobRequest){
		func(req *JobRequest) { req.JobID = "" },
		func(req *JobRequest) { req.JobID = "job id with spaces" },
		func(req *JobRequest) { req.JobID = "job/1" },
		func(req *JobRequest) { req.Printer = "-a" },
		func(req *JobRequest) { req.Printer = "Bixolon\n-evil" },
	} {
		req := validRequest()
		update(&req)
		if _, err := submitJob(manager, req); err == nil {
			t.Fatalf("invalid request was accepted: %+v", req)
		}
	}
}

func TestManagerCapsJobs(t *testing.T) {
	manager := NewManager(&fakeBackend{spoolID: "42"})
	for i := 0; i < maxJobs+5; i++ {
		req := validRequest()
		req.JobID = "job-" + leftPad(int64(i), 3)
		if _, err := submitJob(manager, req); err != nil {
			t.Fatal(err)
		}
	}
	// Active jobs are pollable and must not be evicted just to hit the cap.
	if got := len(manager.Recent(500)); got != maxJobs+5 {
		t.Fatalf("active jobs = %d, want %d", got, maxJobs+5)
	}
	manager.mu.Lock()
	finished := 0
	for _, rec := range manager.jobs {
		if finished >= 5 {
			break
		}
		rec.Status = "done"
		finished++
	}
	manager.cleanupLocked()
	manager.mu.Unlock()
	if got := len(manager.Recent(500)); got != maxJobs {
		t.Fatalf("stored jobs after terminal eviction = %d, want %d", got, maxJobs)
	}
}

func TestManagerSerialisesJobsPerPrinter(t *testing.T) {
	fake := &fakeBackend{
		spoolID:    "42",
		printDelay: 10 * time.Millisecond,
		printers: []backend.Printer{
			{Name: "Bixolon"},
			{Name: "Office"},
		},
	}
	manager := NewManager(fake)
	// Same queue: the manager must not overlap its raw writes.
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := validRequest()
			req.JobID = "same-" + leftPad(int64(i), 2)
			if _, err := submitJob(manager, req); err != nil {
				t.Errorf("submit: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if fake.maxInFlight != 1 {
		t.Fatalf("same-printer jobs overlapped: max=%d", fake.maxInFlight)
	}

	// Different queues may proceed independently.
	fake.mu.Lock()
	fake.maxInFlight = 0
	fake.mu.Unlock()
	for i := 0; i < 2; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			req := validRequest()
			req.JobID = "bix-" + leftPad(int64(i), 2)
			if _, err := submitJob(manager, req); err != nil {
				t.Errorf("submit: %v", err)
			}
		}(i)
		go func(i int) {
			defer wg.Done()
			req := validRequest()
			req.JobID = "office-" + leftPad(int64(i), 2)
			req.Printer = "Office"
			if _, err := submitJob(manager, req); err != nil {
				t.Errorf("submit: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if fake.maxInFlight != 2 {
		t.Fatalf("different printers did not overlap: max=%d", fake.maxInFlight)
	}
}

func TestManagerRetryAfterFailure(t *testing.T) {
	fake := &fakeBackend{spoolID: "42", printErr: &backend.Error{Code: "PAPER_OUT", Message: "load paper"}}
	manager := NewManager(fake)
	first, err := submitJob(manager, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "failed" || first.Error != "PAPER_OUT" {
		t.Fatalf("first = %+v", first)
	}
	fake.mu.Lock()
	fake.printErr = nil
	fake.mu.Unlock()
	second, err := submitJob(manager, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if second.Status != "spooled" {
		t.Fatalf("retry = %+v", second)
	}
	if fake.printCalls != 2 {
		t.Fatalf("retry printed %d times, want 2", fake.printCalls)
	}
}

func TestManagerRejectsBadRequest(t *testing.T) {
	manager := NewManager(&fakeBackend{})
	req := validRequest()
	req.Encoding = "png"
	if _, err := submitJob(manager, req); err == nil {
		t.Fatal("raw job with png encoding was accepted")
	}
	req = validRequest()
	req.Copies = 9
	if _, err := submitJob(manager, req); err == nil {
		t.Fatal("copies above 3 was accepted")
	}
}

func TestManagerCancel(t *testing.T) {
	fake := &fakeBackend{spoolID: "7", status: backend.Status{State: "printing"}}
	manager := NewManager(fake)
	if _, err := submitJob(manager, validRequest()); err != nil {
		t.Fatal(err)
	}
	job, found, err := manager.Cancel(context.Background(), "job-1")
	if err != nil || !found || job.Status != "canceled" {
		t.Fatalf("cancel = %+v, found = %v, err = %v", job, found, err)
	}
}

func TestManagerCancelFailure(t *testing.T) {
	fake := &fakeBackend{spoolID: "7", status: backend.Status{State: "printing"}, cancelErr: errors.New("no")}
	manager := NewManager(fake)
	if _, err := submitJob(manager, validRequest()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := manager.Cancel(context.Background(), "job-1"); err == nil {
		t.Fatal("cancel failure was hidden")
	}
}

// A poll that was already talking to the spooler when Cancel landed must not
// write the spooler's older "printing"/"done" snapshot over the terminal state.
func TestManagerGetDoesNotOverwriteCanceled(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	fake := &fakeBackend{spoolID: "42", status: backend.Status{State: "printing"}}
	fake.statusHook = func() {
		close(entered)
		<-release
	}
	manager := NewManager(fake)
	if _, err := submitJob(manager, validRequest()); err != nil {
		t.Fatal(err)
	}

	polled := make(chan *JobStatus, 1)
	go func() {
		status, ok := manager.Get(context.Background(), "job-1")
		if !ok {
			polled <- nil
			return
		}
		polled <- status
	}()
	<-entered
	if _, found, err := manager.Cancel(context.Background(), "job-1"); err != nil || !found {
		t.Fatalf("cancel = %v, %v", found, err)
	}
	close(release)
	got := <-polled
	if got == nil || got.Status != "canceled" {
		t.Fatalf("polled status = %+v, want canceled", got)
	}
}

func TestManagerRejectsInvalidPNGBeforeTheBackend(t *testing.T) {
	fake := &fakeBackend{spoolID: "42"}
	manager := NewManager(fake)
	req := validRequest()
	req.Mode = "driver"
	req.Encoding = "png"
	req.Data = base64.StdEncoding.EncodeToString([]byte("not a png"))
	job, err := submitJob(manager, req)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != "failed" || job.Error != "SPOOL_ERROR" {
		t.Fatalf("job = %+v", job)
	}
	if fake.printCalls != 0 {
		t.Fatalf("unvalidated PNG reached the backend (%d prints)", fake.printCalls)
	}
}

func (f *fakeBackend) cancelSnapshot() (int, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cancelCalls, append([]string(nil), f.canceledIDs...)
}

// A DELETE that lands while the backend is still spooling sees no spool id. The
// job is marked canceled immediately, and Submit must cancel the OS job that
// appears once Print returns instead of printing a dropped receipt (PRT-H4).
func TestManagerCancelDuringPrintCancelsTheSpooledJob(t *testing.T) {
	fake := &fakeBackend{
		spoolID:      "42",
		printEntered: make(chan struct{}),
		printRelease: make(chan struct{}),
	}
	manager := NewManager(fake)
	submitted := make(chan *JobStatus, 1)
	go func() {
		job, err := submitJob(manager, validRequest())
		if err != nil {
			t.Errorf("submit: %v", err)
		}
		submitted <- job
	}()
	<-fake.printEntered

	job, found, err := manager.Cancel(context.Background(), "job-1")
	if err != nil || !found {
		t.Fatalf("cancel = %v, %v", found, err)
	}
	if job.Status != "canceled" {
		t.Fatalf("cancel returned %q, want canceled", job.Status)
	}
	// Nothing was spooled yet, so there was nothing to cancel at the OS level.
	if calls, _ := fake.cancelSnapshot(); calls != 0 {
		t.Fatalf("pre-spool cancel called the backend %d times", calls)
	}

	close(fake.printRelease)
	result := <-submitted
	if result == nil || result.Status != "canceled" {
		t.Fatalf("submit after cancel = %+v, want canceled", result)
	}
	calls, cancelled := fake.cancelSnapshot()
	if calls != 1 || len(cancelled) != 1 || cancelled[0] != "42" {
		t.Fatalf("spooled job cancel = %d calls %v, want [42]", calls, cancelled)
	}
	status, ok := manager.GetNoPoll("job-1")
	if !ok || status.Status != "canceled" {
		t.Fatalf("stored status = %+v, ok = %v", status, ok)
	}
}

// If backend.Print fails after a cancel, update() must not turn the canceled job
// into "failed".
func TestManagerCancelDuringPrintSurvivesAPrintFailure(t *testing.T) {
	fake := &fakeBackend{
		printErr:     &backend.Error{Code: "PAPER_OUT", Message: "load paper"},
		printEntered: make(chan struct{}),
		printRelease: make(chan struct{}),
	}
	manager := NewManager(fake)
	submitted := make(chan *JobStatus, 1)
	go func() {
		job, err := submitJob(manager, validRequest())
		if err != nil {
			t.Errorf("submit: %v", err)
		}
		submitted <- job
	}()
	<-fake.printEntered
	if _, found, err := manager.Cancel(context.Background(), "job-1"); err != nil || !found {
		t.Fatalf("cancel = %v, %v", found, err)
	}
	close(fake.printRelease)
	if result := <-submitted; result == nil || result.Status != "canceled" {
		t.Fatalf("submit after cancel = %+v, want canceled", result)
	}
	status, _ := manager.GetNoPoll("job-1")
	if status.Status != "canceled" || status.Error != "" {
		t.Fatalf("print failure overwrote the canceled job: %+v", status)
	}
}

// Cancel must not mark a retry attempt canceled when backend.Cancel replaces
// the record underneath it, and it must return the current record (PRT-H4).
func TestManagerCancelDoesNotTouchAReplacementRecord(t *testing.T) {
	fake := &fakeBackend{
		spoolID:       "7",
		status:        backend.Status{State: "failed", Error: "PAPER_OUT"},
		cancelEntered: make(chan struct{}),
		cancelRelease: make(chan struct{}),
	}
	manager := NewManager(fake)
	if _, err := submitJob(manager, validRequest()); err != nil {
		t.Fatal(err)
	}

	type cancelResult struct {
		job *JobStatus
		err error
	}
	cancelled := make(chan cancelResult, 1)
	go func() {
		job, _, err := manager.Cancel(context.Background(), "job-1")
		cancelled <- cancelResult{job: job, err: err}
	}()
	<-fake.cancelEntered

	// The spooler reports a failure while Cancel is talking to the OS, then the
	// till retries the same print-job id and Submit replaces the record.
	if job, ok := manager.Get(context.Background(), "job-1"); !ok || job.Status != "failed" {
		t.Fatalf("polled job = %+v, ok = %v", job, ok)
	}
	fake.mu.Lock()
	fake.spoolID = "99"
	fake.mu.Unlock()
	retry, err := submitJob(manager, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if retry.Status != "spooled" {
		t.Fatalf("retry = %+v", retry)
	}

	close(fake.cancelRelease)
	result := <-cancelled
	if result.err != nil {
		t.Fatal(result.err)
	}
	if result.job == nil || result.job.Status != "spooled" {
		t.Fatalf("cancel returned %+v, want the replacement's spooled status", result.job)
	}
	status, _ := manager.GetNoPoll("job-1")
	if status.Status != "spooled" {
		t.Fatalf("replacement was marked %q by the stale cancel", status.Status)
	}
	calls, canceledIDs := fake.cancelSnapshot()
	if calls != 1 || len(canceledIDs) != 1 || canceledIDs[0] != "7" {
		t.Fatalf("cancelled ids = %v (%d calls), want only the old spool job", canceledIDs, calls)
	}
}

// A status poll that returns an error after the record was replaced must not
// write the old attempt's error detail onto the retry.
func TestManagerGetErrorDoesNotOverwriteARetriedRecord(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	fake := &fakeBackend{spoolID: "7", statusErr: errors.New("spooler down")}
	fake.statusHook = func() {
		close(entered)
		<-release
	}
	manager := NewManager(fake)
	if _, err := submitJob(manager, validRequest()); err != nil {
		t.Fatal(err)
	}

	polled := make(chan *JobStatus, 1)
	go func() {
		job, ok := manager.Get(context.Background(), "job-1")
		if !ok {
			polled <- nil
			return
		}
		polled <- job
	}()
	<-entered
	if _, found, err := manager.Cancel(context.Background(), "job-1"); err != nil || !found {
		t.Fatalf("cancel = %v, %v", found, err)
	}
	fake.mu.Lock()
	fake.spoolID = "99"
	fake.statusHook = nil
	fake.mu.Unlock()
	retry, err := submitJob(manager, validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if retry.Status != "spooled" {
		t.Fatalf("retry = %+v", retry)
	}
	close(release)
	if got := <-polled; got == nil || got.Status != "spooled" || got.Detail != "" {
		t.Fatalf("polled status = %+v, want the new spooled record without the old error", got)
	}
	status, _ := manager.GetNoPoll("job-1")
	if status.Status != "spooled" || status.Detail != "" {
		t.Fatalf("stored job = %+v, want spooled without detail", status)
	}
}
