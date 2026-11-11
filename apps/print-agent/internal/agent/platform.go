package agent

import "runtime"

func platformOS() string   { return runtime.GOOS }
func platformArch() string { return runtime.GOARCH }
