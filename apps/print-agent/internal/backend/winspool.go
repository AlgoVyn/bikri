package backend

import "math"

// errorInsufficientBuffer is returned by EnumPrintersW/GetDefaultPrinterW when
// the caller's buffer is too small (or NULL) and the needed size is filled in.
const errorInsufficientBuffer = 122

// acceptDefaultPrinterBuffer reports whether a GetDefaultPrinterW length query
// produced a usable buffer size. The NULL-buffer call always returns FALSE with
// ERROR_INSUFFICIENT_BUFFER while filling `needed`; treating every FALSE as a
// failure made the default printer invisible on every Windows machine.
func acceptDefaultPrinterBuffer(r1 uintptr, errno uint32, needed uint32) bool {
	if needed == 0 {
		return false
	}
	if r1 != 0 {
		return true
	}
	return errno == errorInsufficientBuffer
}

// GDI device-capability indices, map mode and raster op used by the Windows
// image path.
const (
	gdiLogPixelsX = 88
	gdiLogPixelsY = 90
	gdiHorzRes    = 8
	gdiMMText     = 1
	gdiHalftone   = 4
)

// gdiTargetSize converts the source bitmap into device pixels. The image path
// draws in MM_TEXT, where one unit is one printer pixel, so sending a 576-dot
// receipt 1:1 produced a 24 mm strip on a 600 dpi driver. Use the physical paper
// width and the driver's real resolution instead, never wider than the printable
// area the driver reports, and preserve the aspect ratio.
func gdiTargetSize(width, height, paperMm, dpiX, dpiY, horizRes int) (int, int) {
	if width < 1 || height < 1 {
		return 0, 0
	}
	if dpiX <= 0 {
		dpiX = dpiY
	}
	targetWidth := width
	if paperMm > 0 && dpiX > 0 {
		targetWidth = int(math.Round(float64(dpiX) * float64(paperMm) / 25.4))
	}
	if horizRes > 0 && targetWidth > horizRes {
		targetWidth = horizRes
	}
	if targetWidth < 1 {
		targetWidth = width
	}
	// Keep the physical aspect ratio when the driver's X and Y DPI differ.
	scaleY := 1.0
	if dpiX > 0 && dpiY > 0 {
		scaleY = float64(dpiY) / float64(dpiX)
	}
	targetHeight := int(
		math.Round(float64(height) * float64(targetWidth) / float64(width) * scaleY),
	)
	if targetHeight < 1 {
		targetHeight = 1
	}
	return targetWidth, targetHeight
}
