package agent

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/algovyn/bikri/apps/print-agent/internal/backend"
)

type fakeBackend struct {
	mu         sync.Mutex
	printCalls int
	printErr   error
	spoolID    string
	status     backend.Status
	statusErr  error
	cancelErr  error
	printers   []backend.Printer
}

func (f *fakeBackend) ListPrinters(context.Context) ([]backend.Printer, error) {
	return f.printers, nil
}

func (f *fakeBackend) Print(context.Context, backend.Job) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.printCalls++
	if f.printErr != nil {
		return "", f.printErr
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
		Printer:  "Test",
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
