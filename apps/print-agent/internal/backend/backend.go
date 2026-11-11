// Package backend defines the OS printing interface used by the Bikri print agent.
//
// The agent deliberately talks to the operating system's print queue rather than
// replacing a driver: raw ESC/POS goes through the spooler/CUPS port, and the
// compatibility path sends a rendered image through the installed driver.
package backend

import "context"

// Printer is one installed OS print queue.
type Printer struct {
	Name      string `json:"name"`
	Driver    string `json:"driver,omitempty"`
	Port      string `json:"port,omitempty"`
	IsDefault bool   `json:"isDefault"`
	// SupportsRaw is nil until the agent has observed a raw job on this queue.
	SupportsRaw *bool `json:"supportsRaw,omitempty"`
}

// Job is one print request. Data is the already-decoded document.
type Job struct {
	ID        string
	Printer   string
	Mode      string // "raw" or "driver"
	PaperMM   int
	WidthDots int
	Copies    int
	Encoding  string // "escpos" or "png"
	Data      []byte
}

// Status is the OS-reported state of a submitted job.
type Status struct {
	State  string `json:"state"`
	Error  string `json:"error,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// Error is an agent-visible backend failure.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Backend is implemented per operating system.
type Backend interface {
	ListPrinters(ctx context.Context) ([]Printer, error)
	Print(ctx context.Context, job Job) (spoolID string, err error)
	Status(ctx context.Context, printer, spoolID string) (Status, error)
	Cancel(ctx context.Context, printer, spoolID string) error
}
