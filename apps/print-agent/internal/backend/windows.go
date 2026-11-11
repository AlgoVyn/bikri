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

var (
	winspool = syscall.NewLazyDLL("winspool.drv")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")

	procOpenPrinterW       = winspool.NewProc("OpenPrinterW")
	procClosePrinter       = winspool.NewProc("ClosePrinter")
	procStartDocPrinterW   = winspool.NewProc("StartDocPrinterW")
	procStartPagePrinter   = winspool.NewProc("StartPagePrinter")
	procWritePrinter       = winspool.NewProc("WritePrinter")
	procEndPagePrinter     = winspool.NewProc("EndPagePrinter")
	procEndDocPrinter      = winspool.NewProc("EndDocPrinter")
	procEnumPrintersW      = winspool.NewProc("EnumPrintersW")
	procGetDefaultPrinterW = winspool.NewProc("GetDefaultPrinterW")
	procGetJobW            = winspool.NewProc("GetJobW")
	procSetJobW            = winspool.NewProc("SetJobW")

	procCreateDCW     = gdi32.NewProc("CreateDCW")
	procDeleteDC      = gdi32.NewProc("DeleteDC")
	procStartDocW     = gdi32.NewProc("StartDocW")
	procStartPage     = gdi32.NewProc("StartPage")
	procEndPage       = gdi32.NewProc("EndPage")
	procEndDoc        = gdi32.NewProc("EndDoc")
	procSetMapMode    = gdi32.NewProc("SetMapMode")
	procStretchDIBits = gdi32.NewProc("StretchDIBits")
)

type windowsBackend struct {
	mu             sync.Mutex
	rawUnsupported map[string]bool
}

type docInfo1 struct {
	pDocName    *uint16
	pOutputFile *uint16
	pDatatype   *uint16
}

type printerInfo4 struct {
	pPrinterName *uint16
	pServerName  *uint16
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

func (b *windowsBackend) ListPrinters(ctx context.Context) ([]Printer, error) {
	var needed, returned uint32
	_, _, _ = procEnumPrintersW.Call(
		printerEnumLocal|printerEnumConnections,
		0,
		4,
		0,
		0,
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)),
	)
	if needed == 0 {
		return []Printer{}, nil
	}
	buf := make([]byte, needed)
	r1, _, err := procEnumPrintersW.Call(
		printerEnumLocal|printerEnumConnections,
		0,
		4,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(needed),
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)),
	)
	if r1 == 0 {
		return nil, &Error{Code: "SPOOL_ERROR", Message: lastError(err)}
	}
	if returned == 0 {
		return []Printer{}, nil
	}
	rows := unsafe.Slice((*printerInfo4)(unsafe.Pointer(&buf[0])), returned)
	defaultName := defaultPrinter()
	printers := make([]Printer, 0, len(rows))
	for _, row := range rows {
		name := utf16PtrString(row.pPrinterName)
		if name == "" {
			continue
		}
		printers = append(printers, Printer{
			Name:      name,
			IsDefault: name == defaultName,
		})
	}
	return printers, nil
}

func (b *windowsBackend) Print(ctx context.Context, job Job) (string, error) {
	if job.Mode == "driver" {
		// GDI's StartDoc does not return the spooler job id, so the compatibility
		// path is reported done once EndDoc accepts the document. Raw jobs keep
		// the real spooler id and are polled for status.
		return "", b.printImage(job)
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

	docName, _ := syscall.UTF16PtrFromString("Bikri " + job.ID)
	dataType, _ := syscall.UTF16PtrFromString("RAW")
	doc := docInfo1{pDocName: docName, pDatatype: dataType}
	jobID, _, callErr := procStartDocPrinterW.Call(
		uintptr(handle),
		1,
		uintptr(unsafe.Pointer(&doc)),
	)
	if jobID == 0 {
		if isRawUnsupported(callErr) {
			b.mu.Lock()
			b.rawUnsupported[job.Printer] = true
			b.mu.Unlock()
			return "", &Error{Code: "RAW_UNSUPPORTED", Message: lastError(callErr)}
		}
		return "", &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	defer procEndDocPrinter.Call(uintptr(handle))

	r1, _, callErr := procStartPagePrinter.Call(uintptr(handle))
	if r1 == 0 {
		return "", &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	defer procEndPagePrinter.Call(uintptr(handle))

	for i := 0; i < max(1, job.Copies); i++ {
		for at := 0; at < len(job.Data); at += 4096 {
			end := min(at+4096, len(job.Data))
			chunk := job.Data[at:end]
			var written uint32
			r1, _, callErr = procWritePrinter.Call(
				uintptr(handle),
				uintptr(unsafe.Pointer(&chunk[0])),
				uintptr(len(chunk)),
				uintptr(unsafe.Pointer(&written)),
			)
			if r1 == 0 {
				return "", &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
			}
		}
	}
	runtime.KeepAlive(job.Data)
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
	_, _, _ = procGetJobW.Call(
		uintptr(handle),
		uintptr(uint32(id)),
		1,
		0,
		0,
		uintptr(unsafe.Pointer(&needed)),
	)
	if needed == 0 {
		// The spooler removed the job: it normally means it printed.
		return Status{State: "done"}, nil
	}
	buf := make([]byte, needed)
	r1, _, callErr := procGetJobW.Call(
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

func (b *windowsBackend) printImage(job Job) error {
	img, err := png.Decode(bytes.NewReader(job.Data))
	if err != nil {
		return &Error{Code: "SPOOL_ERROR", Message: "invalid PNG: " + err.Error()}
	}
	rgba := image.NewRGBA(img.Bounds())
	draw.Draw(rgba, rgba.Bounds(), img, img.Bounds().Min, draw.Src)
	width := rgba.Bounds().Dx()
	height := rgba.Bounds().Dy()
	if width <= 0 || height <= 0 {
		return &Error{Code: "SPOOL_ERROR", Message: "empty image"}
	}
	// Bottom-up BGRA DIB for StretchDIBits.
	bits := make([]byte, width*height*4)
	for y := 0; y < height; y++ {
		src := (height - 1 - y) * rgba.Stride
		dst := y * width * 4
		for x := 0; x < width; x++ {
			o := src + x*4
			bits[dst+x*4+0] = rgba.Pix[o+2]
			bits[dst+x*4+1] = rgba.Pix[o+1]
			bits[dst+x*4+2] = rgba.Pix[o+0]
			bits[dst+x*4+3] = 0
		}
	}
	printerName, _ := syscall.UTF16PtrFromString(job.Printer)
	driverName, _ := syscall.UTF16PtrFromString("WINSPOOL")
	hdc, _, callErr := procCreateDCW.Call(
		uintptr(unsafe.Pointer(driverName)),
		uintptr(unsafe.Pointer(printerName)),
		0,
		0,
	)
	if hdc == 0 {
		return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	defer procDeleteDC.Call(hdc)
	docName, _ := syscall.UTF16PtrFromString("Bikri " + job.ID)
	doc := docInfo{
		cbSize:      uint32(unsafe.Sizeof(docInfo{})),
		lpszDocName: docName,
	}
	r1, _, callErr := procStartDocW.Call(hdc, uintptr(unsafe.Pointer(&doc)))
	if r1 == 0 {
		return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
	}
	defer procEndDoc.Call(hdc)
	for i := 0; i < max(1, job.Copies); i++ {
		r1, _, callErr = procStartPage.Call(hdc)
		if r1 == 0 {
			return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
		}
		_, _, _ = procSetMapMode.Call(hdc, 1) // MM_TEXT
		bmi := bitmapInfoHeader{
			biSize:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
			biWidth:       int32(width),
			biHeight:      int32(height),
			biPlanes:      1,
			biBitCount:    32,
			biCompression: 0, // BI_RGB
			biSizeImage:   uint32(len(bits)),
		}
		r1, _, callErr = procStretchDIBits.Call(
			hdc,
			0, 0, uintptr(width), uintptr(height),
			0, 0, uintptr(width), uintptr(height),
			uintptr(unsafe.Pointer(&bits[0])),
			uintptr(unsafe.Pointer(&bmi)),
			0,          // DIB_RGB_COLORS
			0x00CC0020, // SRCCOPY
		)
		if r1 == 0 {
			_, _, _ = procEndPage.Call(hdc)
			return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
		}
		r1, _, callErr = procEndPage.Call(hdc)
		if r1 == 0 {
			return &Error{Code: "SPOOL_ERROR", Message: lastError(callErr)}
		}
	}
	runtime.KeepAlive(bits)
	return nil
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
	if r1 == 0 {
		return 0, &Error{Code: "UNKNOWN_PRINTER", Message: lastError(callErr)}
	}
	return handle, nil
}

func defaultPrinter() string {
	var size uint32
	_, _, _ = procGetDefaultPrinterW.Call(0, uintptr(unsafe.Pointer(&size)))
	if size == 0 {
		return ""
	}
	buf := make([]uint16, size)
	r1, _, _ := procGetDefaultPrinterW.Call(
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if r1 == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf)
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
	return ok && (errno == 50 || errno == 87 || errno == 1)
}
