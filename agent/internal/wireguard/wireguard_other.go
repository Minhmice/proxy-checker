//go:build !windows && !linux

package wireguard

import (
	"fmt"
	"os"
	"time"
)

func (m *Manager) initPlatformBackend() {
	m.backend = nil
}

func writeRestrictedAtomic(dir string, targetPath string, data []byte) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmpPath := fmt.Sprintf("%s.tmp.%d", targetPath, time.Now().UnixNano())
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmpPath, targetPath)
}
