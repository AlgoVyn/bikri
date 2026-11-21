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

// ValidatePNG checks a driver-mode payload before any backend decodes it. The
// job manager calls this centrally so CUPS and GDI share one limit (14 §5.2):
// handing an unvalidated PNG (or a decompression bomb) to the OS print path is
// not acceptable just because CUPS would decode it in a filter.
func ValidatePNG(data []byte) error {
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return &Error{Code: "SPOOL_ERROR", Message: "invalid PNG: " + err.Error()}
	}
	if !validImageSize(config.Width, config.Height) {
		return &Error{Code: "SPOOL_ERROR", Message: "image dimensions are too large"}
	}
	return nil
}

// ImageConfig returns the PNG header dimensions for a payload that passed
// ValidatePNG. Driver mode uses the height to derive the custom media length.
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
