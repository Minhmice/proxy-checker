//go:build !linux && !windows

package device

import (
	"os"
	"runtime"
)

func detectPlatform(info *Info) {
	info.OSFamily = runtime.GOOS

	if host, err := os.Hostname(); err == nil && host != "" {
		info.Hostname = host
	} else {
		info.Hostname = "unknown"
	}

	numCPU := runtime.NumCPU()
	if numCPU > 0 {
		info.LogicalCPUs = &numCPU
	}

	addSource(info.Sources, "platform", "unsupported_os_fallback")
}
