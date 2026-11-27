package backend

import (
	"bytes"
	"image/png"
)

// Image dimensions accepted by the Windows GDI compatibility path. A small PNG
// can describe a huge canvas (decompression bomb); checking the IHDR before
// decoding keeps the agent inside a bounded allocation.
const (
	maxImageWidth  = 4096
	maxImageHeight = 32768
	maxImagePixels = 16_000_000
)

// validImageSize reports whether a PNG header is safe to decode and print.
func validImageSize(width, height int) bool {
	if width <= 0 || height <= 0 {
		return false
	}
	if width > maxImageWidth || height > maxImageHeight {
		return false
	}
	return int64(width)*int64(height) <= maxImagePixels
}

// ValidatePNG is the dimensions-free form of ImageConfig, kept for callers
// that only need a yes/no answer before handing the payload to the OS.
func ValidatePNG(data []byte) error {
	_, _, err := ImageConfig(data)
	return err
}

// ImageConfig checks a driver-mode payload before any backend decodes it and
// returns the IHDR dimensions. The job manager calls this centrally so CUPS and
// GDI share one limit (14 §5.2) and the backend does not decode the header a
// second time: handing an unvalidated PNG (or a decompression bomb) to the OS
// print path is not acceptable just because CUPS would decode it in a filter.
func ImageConfig(data []byte) (width, height int, err error) {
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, &Error{Code: "SPOOL_ERROR", Message: "invalid PNG: " + err.Error()}
	}
	if !validImageSize(config.Width, config.Height) {
		return 0, 0, &Error{Code: "SPOOL_ERROR", Message: "image dimensions are too large"}
	}
	return config.Width, config.Height, nil
}

// gdiSucceeded converts a GDI return value. GDI functions return <= 0 on
// failure (SP_ERROR/GDI_ERROR are -1), not just zero.
func gdiSucceeded(value uintptr) bool {
	return int32(value) > 0
}
