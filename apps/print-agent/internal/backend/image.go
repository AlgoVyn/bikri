package backend

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

// gdiSucceeded converts a GDI return value. GDI functions return <= 0 on
// failure (SP_ERROR/GDI_ERROR are -1), not just zero.
func gdiSucceeded(value uintptr) bool {
	return int32(value) > 0
}
