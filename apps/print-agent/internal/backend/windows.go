//go:build windows

package backend

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	printerEnumLocal       = 0x00000002
	printerEnumConnections = 0x00000004
	jobStatusPaused        = 0x00000001
	jobStatusError         = 0x00000002
	jobStatusDeleting      = 0x00000004
	jobStatusSpooling      = 0x00000008
	jobStatusPrinting      = 0x00000010
	jobStatusOffline       = 0x00000020
	jobStatusPaperOut      = 0x00000040
	jobStatusPrinted       = 0x00000080
	jobStatusDeleted       = 0x00000100
	jobStatusBlockedDevQ   = 0x00000200
	jobStatusUserIntervene = 0x00000400
	jobStatusRestart       = 0x00000800
	jobStatusComplete      = 0x00001000
	jobStatusRetained      = 0x00002000
	jobControlCancel       = 2
)

// windowsPrinterTTL is the same short cache CUPS uses: a newly installed queue
// appears without a restart, and a burst of health/printers/diagnostics calls
// does not enumerate the spooler each time.
const windowsPrinterTTL = 10 * time.Second

// windowsRefreshTimeout bounds the shared enumeration work.
const windowsRefreshTimeout = 10 * time.Second

var (
	winspool = syscall.NewLazyDLL("winspool.drv")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")

	procOpenPrinterW      = winspool.NewProc("OpenPrinterW")
	procClosePrinter      = winspool.NewProc("ClosePrinter")
	procStartDocPrinterW  = winspool.NewProc("StartDocPrinterW")
	procStartPagePrinter  = winspool.NewProc("StartPagePrinter")
	procWritePrinter      = winspool.NewProc("WritePrinter")
	procEndPagePrinter    = winspool.NewProc("EndPagePrinter")
	procEndDocPrinter     = winspool.NewProc("EndDocPrinter")
	procAbortPrinter      = winspool.NewProc("AbortPrinter")
	procGetJobW           = winspool.NewProc("GetJobW")
	procSetJobW           = winspool.NewProc("SetJobW")
	procEnumPrintersW     = winspool.NewProc("EnumPrintersW")
	procGetDefaultPrinter = winspool.NewProc("GetDefaultPrinterW")

	procCreateDCW         = gdi32.NewProc("CreateDCW")
	procDeleteDC          = gdi32.NewProc("DeleteDC")
	procStartDocW         = gdi32.NewProc("StartDocW")
	procStartPage         = gdi32.NewProc("StartPage")
	procEndPage           = gdi32.NewProc("EndPage")
	procEndDoc            = gdi32.NewProc("EndDoc")
	procAbortDoc          = gdi32.NewProc("AbortDoc")
	procSetMapMode        = gdi32.NewProc("SetMapMode")
	procStretchDIBits     = gdi32.NewProc("StretchDIBits")
	procGetDeviceCaps     = gdi32.NewProc("GetDeviceCaps")
	procSetStretchBltMode = gdi32.NewProc("SetStretchBltMode")
	procSetBrushOrgEx     = gdi32.NewProc("SetBrushOrgEx")
)

type windowsBackend struct {
	mu             sync.Mutex
	rawUnsupported map[string]bool
	rawSupported   map[string]bool

	printersMu  sync.Mutex
	printers    []Printer
	printersAt  time.Time
	refreshing  bool
	refreshDone chan struct{}
	refreshErr  error
}

type docInfo1 struct {
	pDocName    *uint16
	pOutputFile *uint16
	pDatatype   *uint16
}

type systemTime struct {
	Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds uint16
}

type jobInfo1 struct {
	JobID        uint32
	pPrinterName *uint16
	pMachineName *uint16
	pUserName    *uint16
	pDocument    *uint16
	pDatatype    *uint16
	pStatus      *uint16
	Status       uint32
	Priority     uint32
	Position     uint32
	TotalPages   uint32
	PagesPrinted uint32
	Submitted    systemTime
}

type docInfo struct {
	cbSize       uint32
	lpszDocName  *uint16
	lpszOutput   *uint16
	lpszDatatype *uint16
	fwType       uint32
}

type bitmapInfoHeader struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}

type printerInfo4 struct {
	pPrinterName *uint16
	pServerName  *uint16
	attributes   uint32
}

func (b *windowsBackend) ListPrinters(ctx context.Context) ([]Printer, error) {
	b.printersMu.Lock()
	if b.printers != nil && time.Since(b.printersAt) < windowsPrinterTTL {
		list := append([]Printer(nil), b.printers...)
		b.printersMu.Unlock()
		return b.decorate(list), nil
	}
	if b.refreshing {
		done := b.refreshDone
		b.printersMu.Unlock()
		list, refreshErr, waitErr := b.wait(ctx, done)
		if waitErr != nil {
			return nil, waitErr
		}
		if list == nil && refreshErr != nil {
			return nil, refreshErr
		}
		return b.decorate(list), nil
	}
	b.refreshing = true
	b.refreshDone = make(chan struct{})
	done := b.refreshDone
	hasStale := b.printers != nil
	stale := append([]Printer(nil), b.printers...)
	b.printersMu.Unlock()

	// The refresh is shared by every waiter; do not inherit the first caller's
	// deadline (a 300 ms health probe can lead a 30 s print job).
	go func() {
		refreshCtx, cancel := context.WithTimeout(context.Background(), windowsRefreshTimeout)
		defer cancel()
		b.refresh(refreshCtx, done)
	}()

	list, refreshErr, waitErr := b.wait(ctx, done)
	if waitErr != nil {
		return nil, waitErr
	}
	if refreshErr != nil && hasStale {
		return b.decorate(stale), nil
	}
	if refreshErr != nil {
		return nil, refreshErr
	}
	return b.decorate(list), nil
}

// wait blocks until the singleflight finishes or the caller's deadline wins.
func (b *windowsBackend) wait(ctx context.Context, done chan struct{}) ([]Printer, error, error) {
	select {
	case <-done:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	b.printersMu.Lock()
	list := append([]Printer(nil), b.printers...)
	refreshErr := b.refreshErr
	b.printersMu.Unlock()
	return list, refreshErr, nil
}

// refresh always publishes a result: a panic in the singleflight would
// otherwise leave `refreshing` true and make every later call block forever.
func (b *windowsBackend) refresh(ctx context.Context, done chan struct{}) (list []Printer, err error) {
	defer func() {
		if value := recover(); value != nil {
			err = &Error{Code: "SPOOL_ERROR", Message: fmt.Sprint("printer enumeration failed: ", value)}
		}
		b.printersMu.Lock()
		if err == nil {
			b.printers = append([]Printer{}, list...)
			b.printersAt = time.Now()
		}
		b.refreshErr = err
		b.refreshing = false
		b.refreshDone = nil
		close(done)
		b.printersMu.Unlock()
	}()
	return listWindowsPrinters(ctx)
}

// decorate attaches the optional supportsRaw metadata the agent has learned
// from earlier jobs. No client depends on it (14 §6 marks it optional), so a
// queue that has never seen a raw job simply omits the field.
func (b *windowsBackend) decorate(printers []Printer) []Printer {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Printer, len(printers))
	copy(out, printers)
	for i := range out {
		name := out[i].Name
		switch {
		case b.rawUnsupported[name]:
			value := false
			out[i].SupportsRaw = &value
		case b.rawSupported[name]:
			value := true
			out[i].SupportsRaw = &value
		}
	}
	return out
}

// listWindowsPrinters asks the spooler directly. The old PowerShell/CIM probe took
// 0.5-2.5 s on a shop PC and ran again whenever the 10 s cache expired, stalling
// every receipt; EnumPrintersW is a local call and finishes in well under 20 ms.
func listWindowsPrinters(ctx context.Context) ([]Printer, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	flags := uint32(printerEnumLocal | printerEnumConnections)
	var needed, returned uint32
	r1, _, callErr := procEnumPrintersW.Call(
		uintptr(flags),
		0,
		4,
		0,
		0,
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)),
	)
	if r1 == 0 && errorNumberOf(callErr) != errorInsufficientBuffer {
		return nil, &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	if needed == 0 {
		return []Printer{}, nil
	}
	buf := make([]byte, needed)
	r1, _, callErr = procEnumPrintersW.Call(
		uintptr(flags),
		0,
		4,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(needed),
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)),
	)
	if r1 == 0 {
		return nil, &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	entrySize := int(unsafe.Sizeof(printerInfo4{}))
	if int(returned)*entrySize > len(buf) {
		return nil, &Error{Code: "SPOOL_ERROR", Message: "the spooler returned an invalid printer list"}
	}
	defaultName := defaultPrinterName()
	printers := make([]Printer, 0, returned)
	for i := 0; i < int(returned); i++ {
		info := (*printerInfo4)(unsafe.Pointer(&buf[i*entrySize]))
		name := utf16PtrString(info.pPrinterName)
		if name == "" {
			continue
		}
		printers = append(printers, Printer{Name: name, IsDefault: name == defaultName})
	}
	// utf16PtrString copied every name; the buffer can be released now.
	runtime.KeepAlive(buf)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return printers, nil
}

func defaultPrinterName() string {
	var needed uint32
	r1, _, callErr := procGetDefaultPrinter.Call(0, uintptr(unsafe.Pointer(&needed)))
	// A NULL buffer returns FALSE with ERROR_INSUFFICIENT_BUFFER while filling
	// `needed`; that is success for the length query.
	if !acceptDefaultPrinterBuffer(r1, errorNumberOf(callErr), needed) {
		return ""
	}
	buf := make([]uint16, needed)
	r1, _, _ = procGetDefaultPrinter.Call(
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&needed)),
	)
	if r1 == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

func errorNumberOf(err error) uint32 {
	if errno, ok := err.(syscall.Errno); ok {
		return uint32(errno)
	}
	return 0
}

func (b *windowsBackend) Print(ctx context.Context, job Job) (string, error) {
	if !ValidPrinterName(job.Printer) {
		return "", &Error{Code: "UNKNOWN_PRINTER", Message: "no valid printer name"}
	}
	if job.Mode == "driver" {
		// GDI's StartDoc does not return the spooler job id, so the compatibility
		// path is reported done once EndDoc accepts the document. Raw jobs keep
		// the real spooler id and are polled for status.
		return "", b.printImage(ctx, job)
	}
	b.mu.Lock()
	unsupported := b.rawUnsupported[job.Printer]
	b.mu.Unlock()
	if unsupported {
		return "", &Error{Code: "RAW_UNSUPPORTED", Message: "this queue rejected raw jobs before"}
	}

	handle, err := openPrinter(job.Printer)
	if err != nil {
		return "", err
	}
	defer procClosePrinter.Call(uintptr(handle))

	docName, err := syscall.UTF16PtrFromString("Bikri " + job.ID)
	if err != nil {
		return "", &Error{Code: "SPOOL_ERROR", Message: "invalid job id: " + err.Error()}
	}
	dataType, err := syscall.UTF16PtrFromString("RAW")
	if err != nil {
		return "", &Error{Code: "SPOOL_ERROR", Message: "invalid datatype: " + err.Error()}
	}
	doc := docInfo1{pDocName: docName, pDatatype: dataType}
	jobID, _, callErr := procStartDocPrinterW.Call(
		uintptr(handle),
		1,
		uintptr(unsafe.Pointer(&doc)),
	)
	runtime.KeepAlive(docName)
	runtime.KeepAlive(dataType)
	runtime.KeepAlive(doc)
	if jobID == 0 {
		if isRawUnsupported(callErr) {
			b.mu.Lock()
			b.rawUnsupported[job.Printer] = true
			b.mu.Unlock()
			return "", &Error{Code: "RAW_UNSUPPORTED", Message: lastError(callErr)}
		}
		return "", &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	// fail aborts the spool entry. Finalising a half-written ESC/POS stream with
	// EndDocPrinter would print a truncated receipt (cut mid-raster/QR) and report
	// success; AbortPrinter discards it instead.
	fail := func(message string) (string, error) {
		_, _, _ = procAbortPrinter.Call(uintptr(handle))
		return "", &Error{Code: "SPOOL_ERROR", Message: message}
	}

	r1, _, callErr := procStartPagePrinter.Call(uintptr(handle))
	if r1 == 0 {
		return fail(lastError(callErr))
	}

	for copyIndex := 0; copyIndex < max(1, job.Copies); copyIndex++ {
		for at := 0; at < len(job.Data); at += 4096 {
			if err := ctx.Err(); err != nil {
				return fail(err.Error())
			}
			end := min(at+4096, len(job.Data))
			chunk := job.Data[at:end]
			// The spooler may accept fewer bytes than offered. Keep feeding the
			// remainder; dropping it corrupts raster/QR streams mid-command.
			for len(chunk) > 0 {
				var written uint32
				r1, _, callErr = procWritePrinter.Call(
					uintptr(handle),
					uintptr(unsafe.Pointer(&chunk[0])),
					uintptr(len(chunk)),
					uintptr(unsafe.Pointer(&written)),
				)
				runtime.KeepAlive(chunk)
				if r1 == 0 {
					return fail(lastError(callErr))
				}
				if written == 0 || int(written) > len(chunk) {
					return fail("the spooler accepted no data")
				}
				chunk = chunk[written:]
			}
		}
	}
	runtime.KeepAlive(job.Data)
	r1, _, callErr = procEndPagePrinter.Call(uintptr(handle))
	if r1 == 0 {
		return fail(lastError(callErr))
	}
	r1, _, callErr = procEndDocPrinter.Call(uintptr(handle))
	if r1 == 0 {
		return fail(lastError(callErr))
	}
	b.mu.Lock()
	if b.rawSupported == nil {
		b.rawSupported = map[string]bool{}
	}
	b.rawSupported[job.Printer] = true
	delete(b.rawUnsupported, job.Printer)
	b.mu.Unlock()
	return strconv.FormatUint(uint64(jobID), 10), nil
}

func (b *windowsBackend) Status(ctx context.Context, printer, spoolID string) (Status, error) {
	if spoolID == "" {
		return Status{State: "done"}, nil
	}
	id, err := strconv.ParseUint(spoolID, 10, 32)
	if err != nil {
		return Status{State: "done"}, nil
	}
	handle, err := openPrinter(printer)
	if err != nil {
		return Status{}, err
	}
	defer procClosePrinter.Call(uintptr(handle))

	var needed uint32
	r1, _, callErr := procGetJobW.Call(
		uintptr(handle),
		uintptr(uint32(id)),
		1,
		0,
		0,
		uintptr(unsafe.Pointer(&needed)),
	)
	if r1 == 0 {
		switch errorNumberOf(callErr) {
		case errorInsufficientBuffer:
			// The size query behaved as documented; `needed` is set below.
		case 87, 6: // ERROR_INVALID_PARAMETER / ERROR_INVALID_HANDLE: job gone
			return Status{State: "done"}, nil
		default:
			// A spooler failure is not a completed job. Reporting "done" here
			// hid crashes and access-denied errors from the till.
			return Status{}, &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
		}
	}
	if needed == 0 {
		// The spooler removed the job: it normally means it printed.
		return Status{State: "done"}, nil
	}
	if needed < uint32(unsafe.Sizeof(jobInfo1{})) {
		return Status{}, &Error{Code: "SPOOL_ERROR", Message: "the spooler returned an invalid job record"}
	}
	buf := make([]byte, needed)
	r1, _, callErr = procGetJobW.Call(
		uintptr(handle),
		uintptr(uint32(id)),
		1,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(needed),
		uintptr(unsafe.Pointer(&needed)),
	)
	if r1 == 0 {
		if errno, ok := callErr.(syscall.Errno); ok && (errno == 87 || errno == 6) {
			return Status{State: "done"}, nil
		}
		return Status{}, &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	info := (*jobInfo1)(unsafe.Pointer(&buf[0]))
	status := info.Status
	detail := utf16PtrString(info.pStatus)
	// pStatus points into buf; keep the allocation alive until it is copied.
	runtime.KeepAlive(buf)
	switch {
	case status&jobStatusPrinted != 0 || status&jobStatusComplete != 0:
		return Status{State: "done"}, nil
	case status&jobStatusPaperOut != 0:
		return Status{State: "failed", Error: "PAPER_OUT", Detail: detail}, nil
	case status&jobStatusOffline != 0:
		return Status{State: "failed", Error: "PRINTER_OFFLINE", Detail: detail}, nil
	case status&jobStatusError != 0 || status&jobStatusUserIntervene != 0 || status&jobStatusBlockedDevQ != 0:
		return Status{State: "failed", Error: "SPOOL_ERROR", Detail: detail}, nil
	case status&jobStatusDeleted != 0:
		return Status{State: "canceled"}, nil
	case status&jobStatusPrinting != 0:
		return Status{State: "printing"}, nil
	default:
		return Status{State: "spooled"}, nil
	}
}

func (b *windowsBackend) Cancel(ctx context.Context, printer, spoolID string) error {
	id, err := strconv.ParseUint(spoolID, 10, 32)
	if err != nil {
		return &Error{Code: "CANCEL_FAILED", Message: "invalid job id"}
	}
	handle, err := openPrinter(printer)
	if err != nil {
		return err
	}
	defer procClosePrinter.Call(uintptr(handle))
	r1, _, callErr := procSetJobW.Call(
		uintptr(handle),
		uintptr(uint32(id)),
		0,
		0,
		jobControlCancel,
	)
	if r1 == 0 {
		return &Error{Code: "CANCEL_FAILED", Message: lastError(callErr)}
	}
	return nil
}

func (b *windowsBackend) printImage(ctx context.Context, job Job) error {
	config, err := png.DecodeConfig(bytes.NewReader(job.Data))
	if err != nil {
		return &Error{Code: "SPOOL_ERROR", Message: "invalid PNG: " + err.Error()}
	}
	// Reject the header before Decode allocates the bitmap. A tiny PNG can
	// describe a multi-gigabyte canvas; the agent must not OOM on it.
	if !validImageSize(config.Width, config.Height) {
		return &Error{Code: "SPOOL_ERROR", Message: "image dimensions are too large"}
	}
	img, err := png.Decode(bytes.NewReader(job.Data))
	if err != nil {
		return &Error{Code: "SPOOL_ERROR", Message: "invalid PNG: " + err.Error()}
	}
	rgba := image.NewRGBA(img.Bounds())
	draw.Draw(rgba, rgba.Bounds(), img, img.Bounds().Min, draw.Src)
	width := rgba.Bounds().Dx()
	height := rgba.Bounds().Dy()
	// StretchDIBits reads 32-bit BGRA. Swap R and B in place and pass a top-down
	// DIB (negative height), so the old bottom-up copy - a third full-size bitmap,
	// up to 192 MB across the three - is not allocated.
	for i := 0; i+3 < len(rgba.Pix); i += 4 {
		rgba.Pix[i], rgba.Pix[i+2] = rgba.Pix[i+2], rgba.Pix[i]
	}
	bits := rgba.Pix
	printerName, err := syscall.UTF16PtrFromString(job.Printer)
	if err != nil {
		return &Error{Code: "UNKNOWN_PRINTER", Message: err.Error()}
	}
	driverName, err := syscall.UTF16PtrFromString("WINSPOOL")
	if err != nil {
		return &Error{Code: "SPOOL_ERROR", Message: err.Error()}
	}
	hdc, _, callErr := procCreateDCW.Call(
		uintptr(unsafe.Pointer(driverName)),
		uintptr(unsafe.Pointer(printerName)),
		0,
		0,
	)
	runtime.KeepAlive(driverName)
	runtime.KeepAlive(printerName)
	if hdc == 0 {
		return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	defer procDeleteDC.Call(hdc)
	docName, err := syscall.UTF16PtrFromString("Bikri " + job.ID)
	if err != nil {
		return &Error{Code: "SPOOL_ERROR", Message: "invalid job id: " + err.Error()}
	}
	doc := docInfo{
		cbSize:      uint32(unsafe.Sizeof(docInfo{})),
		lpszDocName: docName,
	}
	r1, _, callErr := procStartDocW.Call(hdc, uintptr(unsafe.Pointer(&doc)))
	runtime.KeepAlive(docName)
	runtime.KeepAlive(doc)
	// StartDocW, StartPage and EndPage return a value <= 0 on failure (SP_ERROR
	// is -1), so `== 0` would miss every failure and keep drawing into a document
	// that was never started.
	if !gdiSucceeded(r1) {
		return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	abort := func() {
		_, _, _ = procAbortDoc.Call(hdc)
	}
	// MM_TEXT coordinates are printer pixels, so a 1:1 StretchDIBits draw was a
	// 24 mm strip on a 600 dpi driver and clipped on a 180 dpi head. Ask the
	// driver for its resolution and printable width and fill the paper instead.
	dpiX := deviceCaps(hdc, gdiLogPixelsX)
	dpiY := deviceCaps(hdc, gdiLogPixelsY)
	horzRes := deviceCaps(hdc, gdiHorzRes)
	vertRes := deviceCaps(hdc, gdiVertRes)
	destWidth, destHeight := gdiTargetSize(width, height, job.PaperMM, dpiX, dpiY, horzRes)
	// A fixed-length page queue clips anything taller than VERTRES. Split the bitmap
	// into page-high source bands instead of sending one oversized StretchDIBits.
	pageHeight := destHeight
	if vertRes > 0 && vertRes < pageHeight {
		pageHeight = vertRes
	}
	for i := 0; i < max(1, job.Copies); i++ {
		for top := 0; top < destHeight; top += pageHeight {
			if err := ctx.Err(); err != nil {
				abort()
				return &Error{Code: "SPOOL_ERROR", Message: err.Error()}
			}
			bandDestHeight := min(pageHeight, destHeight-top)
			srcTop := top * height / destHeight
			srcHeight := bandDestHeight * height / destHeight
			if srcHeight < 1 {
				srcHeight = 1
			}
			if srcTop+srcHeight > height {
				srcHeight = height - srcTop
			}
			r1, _, callErr = procStartPage.Call(hdc)
			if !gdiSucceeded(r1) {
				abort()
				return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
			}
			_, _, _ = procSetMapMode.Call(hdc, gdiMMText)
			// HALFTONE smooths the downscale/upscale instead of dropping rows.
			_, _, _ = procSetStretchBltMode.Call(hdc, gdiHalftone)
			// HALFTONE uses the brush origin; reset it so the first band is not offset.
			_, _, _ = procSetBrushOrgEx.Call(hdc, 0, 0, 0)
			bmi := bitmapInfoHeader{
				biSize:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
				biWidth:       int32(width),
				biHeight:      -int32(height),
				biPlanes:      1,
				biBitCount:    32,
				biCompression: 0, // BI_RGB
				biSizeImage:   uint32(len(bits)),
			}
			r1, _, callErr = procStretchDIBits.Call(
				hdc,
				0, 0, uintptr(destWidth), uintptr(bandDestHeight),
				0, uintptr(srcTop), uintptr(width), uintptr(srcHeight),
				uintptr(unsafe.Pointer(&bits[0])),
				uintptr(unsafe.Pointer(&bmi)),
				0,          // DIB_RGB_COLORS
				0x00CC0020, // SRCCOPY
			)
			runtime.KeepAlive(bits)
			runtime.KeepAlive(bmi)
			if !gdiSucceeded(r1) {
				abort()
				return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
			}
			r1, _, callErr = procEndPage.Call(hdc)
			if !gdiSucceeded(r1) {
				abort()
				return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
			}
		}
	}
	r1, _, callErr = procEndDoc.Call(hdc)
	if !gdiSucceeded(r1) {
		return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	runtime.KeepAlive(bits)
	return nil
}

// deviceCaps returns one GetDeviceCaps value; 0 means the driver did not report
// it (or the call failed), and the caller falls back to a sane default.
func deviceCaps(hdc uintptr, index int32) int {
	value, _, _ := procGetDeviceCaps.Call(hdc, uintptr(index))
	return int(int32(value))
}

func openPrinter(name string) (syscall.Handle, error) {
	ptr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, &Error{Code: "UNKNOWN_PRINTER", Message: err.Error()}
	}
	var handle syscall.Handle
	r1, _, callErr := procOpenPrinterW.Call(
		uintptr(unsafe.Pointer(ptr)),
		uintptr(unsafe.Pointer(&handle)),
		0,
	)
	runtime.KeepAlive(ptr)
	if r1 == 0 {
		return 0, &Error{Code: "UNKNOWN_PRINTER", Message: lastError(callErr)}
	}
	return handle, nil
}

func utf16PtrString(p *uint16) string {
	if p == nil {
		return ""
	}
	var n int
	for {
		ch := *(*uint16)(unsafe.Add(unsafe.Pointer(p), uintptr(n)*2))
		if ch == 0 {
			break
		}
		n++
	}
	if n == 0 {
		return ""
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}

func lastError(err error) string {
	if err == nil {
		return "unknown Windows error"
	}
	if errno, ok := err.(syscall.Errno); ok {
		return fmt.Sprintf("%v (error %d)", errno, uint32(errno))
	}
	return err.Error()
}

func isRawUnsupported(err error) bool {
	errno, ok := err.(syscall.Errno)
	// 1804 is ERROR_INVALID_DATATYPE: v4/XPS drivers reject the RAW spool type.
	return ok && (errno == 50 || errno == 87 || errno == 1 || errno == 1804)
}
