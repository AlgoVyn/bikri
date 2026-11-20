package agent

import (
	"context"
	"errors"
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
	cancelErr   error
	printers    []backend.Printer
	printersErr error
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

func (f *fakeBackend) Print(context.Context, backend.Job) (string, error) {
	f.mu.Lock()
	f.printCalls++
	f.inFlight++
	if f.inFlight > f.maxInFlight {
		f.maxInFlight = f.inFlight
	}
	delay := f.printDelay
	printErr := f.printErr
	f.mu.Unlock()
	if delay > 0 {
		time.Sleep(delay)
	}
	f.mu.Lock()
	f.inFlight--
	f.mu.Unlock()
	if printErr != nil {
		return "", printErr
	}
	return f.spoolID, nil
}

func (f *fakeBackend) Status(context.Context, string, string) (backend.Status, error) {
	return f.status, f.statusErr
}

func (f *fakeBackend) Cancel(context.Context, string, string) error {
	return f.cancelErr
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

func TestManagerSubmitIsIdempotent(t *testing.T) {
	fake := &fakeBackend{spoolID: "42", status: backend.Status{State: "done"}}
	manager := NewManager(fake)
	first, err := manager.Submit(context.Background(), validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "spooled" {
		t.Fatalf("status = %s", first.Status)
	}
	second, err := manager.Submit(context.Background(), validRequest())
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
	job, err := manager.Submit(context.Background(), validRequest())
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
	job, err := manager.Submit(context.Background(), validRequest())
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
	job, err := manager.Submit(context.Background(), validRequest())
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
		if _, err := manager.Submit(context.Background(), req); err == nil {
			t.Fatalf("invalid request was accepted: %+v", req)
		}
	}
}

func TestManagerCapsJobs(t *testing.T) {
	manager := NewManager(&fakeBackend{spoolID: "42"})
	for i := 0; i < maxJobs+5; i++ {
		req := validRequest()
		req.JobID = "job-" + leftPad(int64(i), 3)
		if _, err := manager.Submit(context.Background(), req); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(manager.Recent(500)); got != maxJobs {
		t.Fatalf("stored jobs = %d, want %d", got, maxJobs)
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
			if _, err := manager.Submit(context.Background(), req); err != nil {
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
			if _, err := manager.Submit(context.Background(), req); err != nil {
				t.Errorf("submit: %v", err)
			}
		}(i)
		go func(i int) {
			defer wg.Done()
			req := validRequest()
			req.JobID = "office-" + leftPad(int64(i), 2)
			req.Printer = "Office"
			if _, err := manager.Submit(context.Background(), req); err != nil {
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
	first, err := manager.Submit(context.Background(), validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "failed" || first.Error != "PAPER_OUT" {
		t.Fatalf("first = %+v", first)
	}
	fake.mu.Lock()
	fake.printErr = nil
	fake.mu.Unlock()
	second, err := manager.Submit(context.Background(), validRequest())
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
	if _, err := manager.Submit(context.Background(), req); err == nil {
		t.Fatal("raw job with png encoding was accepted")
	}
	req = validRequest()
	req.Copies = 9
	if _, err := manager.Submit(context.Background(), req); err == nil {
		t.Fatal("copies above 3 was accepted")
	}
}

func TestManagerCancel(t *testing.T) {
	fake := &fakeBackend{spoolID: "7", status: backend.Status{State: "printing"}}
	manager := NewManager(fake)
	if _, err := manager.Submit(context.Background(), validRequest()); err != nil {
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
	if _, err := manager.Submit(context.Background(), validRequest()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := manager.Cancel(context.Background(), "job-1"); err == nil {
		t.Fatal("cancel failure was hidden")
	}
}
