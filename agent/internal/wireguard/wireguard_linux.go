//go:build linux

package wireguard

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type defaultCommandRunner struct{}

func (r *defaultCommandRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		rawErrOutput := strings.TrimSpace(stderr.String())
		if rawErrOutput == "" {
			rawErrOutput = strings.TrimSpace(stdout.String())
		}
		safeErrOutput := sanitizeDiagnosticOutput(rawErrOutput)
		return stdout.String(), fmt.Errorf("command %s failed: %w (output: %s)", filepath.Base(name), err, safeErrOutput)
	}
	return stdout.String(), nil
}

type linuxBackend struct {
	runner commandRunner
}

func (m *Manager) initPlatformBackend() {
	if m.runner == nil {
		m.runner = &defaultCommandRunner{}
	}
	m.backend = &linuxBackend{runner: m.runner}
}

func writeRestrictedAtomic(dir string, targetPath string, data []byte) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create directory %s: %w", dir, err)
	}
	tmpPath := fmt.Sprintf("%s.tmp.%d", targetPath, time.Now().UnixNano())
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("failed to create temporary file: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to write temporary file: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to sync temporary file: %w", err)
	}
	_ = f.Close()
	_ = f.Chmod(0600)

	// Safe atomic replace preserving existing file if rename fails
	if _, statErr := os.Stat(targetPath); statErr == nil {
		bakPath := fmt.Sprintf("%s.bak.%d", targetPath, time.Now().UnixNano())
		if err := os.Rename(targetPath, bakPath); err != nil {
			_ = os.Remove(tmpPath)
			return fmt.Errorf("failed to backup existing config %s: %w", targetPath, err)
		}
		if err := os.Rename(tmpPath, targetPath); err != nil {
			_ = os.Rename(bakPath, targetPath)
			_ = os.Remove(tmpPath)
			return fmt.Errorf("failed to replace target %s; restored backup: %w", targetPath, err)
		}
		_ = os.Remove(bakPath)
	} else {
		if err := os.Rename(tmpPath, targetPath); err != nil {
			_ = os.Remove(tmpPath)
			return fmt.Errorf("failed to rename temporary file to %s: %w", targetPath, err)
		}
	}
	return nil
}

func (b *linuxBackend) DetectTools() error {
	if _, err := exec.LookPath("wg"); err != nil {
		return errors.New("wireguard tool 'wg' not found in PATH")
	}
	if _, err := exec.LookPath("wg-quick"); err != nil {
		return errors.New("wireguard tool 'wg-quick' not found in PATH; required for interface management")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errors.New("init system 'systemctl' not found in PATH; required for restart persistence")
	}
	return nil
}

func (b *linuxBackend) ConfigureInterface(ctx context.Context, confPath string, desired Desired) error {
	wgQuick, err := exec.LookPath("wg-quick")
	if err != nil {
		return err
	}
	sysctl, err := exec.LookPath("systemctl")
	if err != nil {
		return err
	}

	absConfPath, err := filepath.Abs(confPath)
	if err != nil {
		return fmt.Errorf("resolve abs conf path error: %w", err)
	}

	confData, err := os.ReadFile(absConfPath)
	if err != nil {
		return fmt.Errorf("read config file error: %w", err)
	}

	// 1. Preflight and align with /etc/wireguard/<iface>.conf for reboot persistence
	etcWgDir := "/etc/wireguard"
	etcWgPath := filepath.Join(etcWgDir, desired.InterfaceName+".conf")

	var etcBackupData []byte
	hadEtcExisting := false

	if absConfPath != etcWgPath {
		if existing, readErr := os.ReadFile(etcWgPath); readErr == nil {
			content := string(existing)
			if !strings.HasPrefix(content, OwnedHeaderPrefix) {
				return fmt.Errorf("%w: existing %s is foreign", ErrForeignOwnership, etcWgPath)
			}
			etcBackupData = existing
			hadEtcExisting = true
		} else if !os.IsNotExist(readErr) {
			return fmt.Errorf("%w: cannot read existing %s: %v", ErrForeignOwnership, etcWgPath, readErr)
		}

		if err := writeRestrictedAtomic(etcWgDir, etcWgPath, confData); err != nil {
			return fmt.Errorf("failed to write systemd wireguard config to %s: %w", etcWgPath, err)
		}
	}

	targetConf := absConfPath
	if _, statErr := os.Stat(etcWgPath); statErr == nil {
		targetConf = etcWgPath
	}

	rollbackEtc := func() {
		if absConfPath != etcWgPath {
			if hadEtcExisting {
				_ = writeRestrictedAtomic(etcWgDir, etcWgPath, etcBackupData)
			} else {
				_ = os.Remove(etcWgPath)
			}
		}
	}

	// 2. Check if interface is already running
	dump, dumpErr := b.ReadDump(ctx, desired.InterfaceName)
	if dumpErr == nil && strings.TrimSpace(dump) != "" {
		// Interface is already up and verified owned.
		// Use wg-quick down then up to refresh cleanly, or sync configuration
		_, _ = b.runner.Run(ctx, wgQuick, "down", targetConf)
		time.Sleep(300 * time.Millisecond)
	}

	// 3. Bring up interface with full path
	if _, err := b.runner.Run(ctx, wgQuick, "up", targetConf); err != nil {
		rollbackEtc()
		return fmt.Errorf("wg-quick up failed: %w", err)
	}

	// 4. Enable systemd service for restart persistence
	if _, err := b.runner.Run(ctx, sysctl, "enable", "wg-quick@"+desired.InterfaceName); err != nil {
		// If enable fails, take down interface, restore configs, and propagate failure
		_, _ = b.runner.Run(ctx, wgQuick, "down", targetConf)
		rollbackEtc()
		return fmt.Errorf("failed to enable systemd service wg-quick@%s: %w", desired.InterfaceName, err)
	}

	return nil
}

func (b *linuxBackend) RemoveInterface(ctx context.Context, ifaceName string) error {
	if ifaceName != DefaultInterfaceName {
		return fmt.Errorf("%w: refusing to remove non-proxyfleet interface %s", ErrForeignOwnership, ifaceName)
	}

	etcWgPath := filepath.Join("/etc/wireguard", ifaceName+".conf")

	// Verify ownership before removing /etc/wireguard config
	if existing, readErr := os.ReadFile(etcWgPath); readErr == nil {
		if !strings.HasPrefix(string(existing), OwnedHeaderPrefix) {
			return fmt.Errorf("%w: refusing to delete foreign configuration %s", ErrForeignOwnership, etcWgPath)
		}
	}

	if sysctl, err := exec.LookPath("systemctl"); err == nil {
		if _, err := b.runner.Run(ctx, sysctl, "disable", "wg-quick@"+ifaceName); err != nil {
			return fmt.Errorf("failed to disable systemd service: %w", err)
		}
	}

	if wgQuick, err := exec.LookPath("wg-quick"); err == nil {
		if _, err := b.runner.Run(ctx, wgQuick, "down", ifaceName); err != nil {
			return fmt.Errorf("failed to bring down interface: %w", err)
		}
	}

	_ = os.Remove(etcWgPath)
	return nil
}

func (b *linuxBackend) ReadDump(ctx context.Context, ifaceName string) (string, error) {
	wgCmd, err := exec.LookPath("wg")
	if err != nil {
		return "", err
	}
	return b.runner.Run(ctx, wgCmd, "show", ifaceName, "dump")
}

func (b *linuxBackend) RestartInterface(ctx context.Context, confPath string, desired Desired) error {
	if err := b.RemoveInterface(ctx, desired.InterfaceName); err != nil {
		return fmt.Errorf("failed to remove existing interface during restart: %w", err)
	}
	time.Sleep(500 * time.Millisecond)
	return b.ConfigureInterface(ctx, confPath, desired)
}
