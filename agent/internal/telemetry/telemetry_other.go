//go:build !linux && !windows

package telemetry

import (
	"context"
	"time"
)

func (c *Collector) samplePlatform(ctx context.Context, managedPorts []int, snap *Snapshot) {
	now := time.Now().UnixMilli()
	snap.Proxy.CheckedAt = &now
	addUnavailable(snap.Unavailable, "platform", "unsupported_os_fallback")
}
