//go:build windows

package wireguard

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
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
		// Scrub sensitive private keys from error diagnostic output and bound length
		safeErrOutput := sanitizeDiagnosticOutput(rawErrOutput)
		return stdout.String(), fmt.Errorf("command %s failed: %w (output: %s)", filepath.Base(name), err, safeErrOutput)
	}
	return stdout.String(), nil
}

type windowsBackend struct {
	runner commandRunner
}

func (m *Manager) initPlatformBackend() {
	if m.runner == nil {
		m.runner = &defaultCommandRunner{}
	}
	m.backend = &windowsBackend{runner: m.runner}
}

func writeRestrictedAtomic(dir string, targetPath string, data []byte) error {
	// 1. Ensure directory exists and is secured BEFORE writing any files
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create config directory %s: %w", dir, err)
	}

	icacls, err := exec.LookPath("icacls.exe")
	if err != nil {
		return fmt.Errorf("icacls.exe not found in PATH: required for Windows ACL security: %w", err)
	}

	// Restrict directory inheritance: grant full control to SYSTEM (*S-1-5-18), Administrators (*S-1-5-32-544), and Current User SID
	u, err := user.Current()
	if err != nil || strings.TrimSpace(u.Uid) == "" {
		return fmt.Errorf("cannot resolve current user SID for restricted WireGuard storage")
	}
	userDirGrant := "*" + strings.TrimSpace(u.Uid) + ":(OI)(CI)(F)"
	userFileGrant := "*" + strings.TrimSpace(u.Uid) + ":(F)"

	dirCmd := exec.Command(icacls, dir, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)(F)", "/grant:r", "*S-1-5-32-544:(OI)(CI)(F)", "/grant:r", userDirGrant)
	if out, err := dirCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to secure directory ACL on %s: %w (output: %s)", dir, err, sanitizeDiagnosticOutput(string(out)))
	}

	// 2. Create EMPTY temporary file first (ZERO secret bytes exposed)
	tmpPath := fmt.Sprintf("%s.tmp.%d", targetPath, time.Now().UnixNano())
	emptyFile, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("failed to create empty temporary file %s: %w", tmpPath, err)
	}
	_ = emptyFile.Close()

	// 3. Apply explicit restrictive ACL to the empty temporary file BEFORE writing secret data
	fileCmd := exec.Command(icacls, tmpPath, "/inheritance:r", "/grant:r", "*S-1-5-18:(F)", "/grant:r", "*S-1-5-32-544:(F)", "/grant:r", userFileGrant)
	if out, err := fileCmd.CombinedOutput(); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to secure temporary file ACL on %s: %w (output: %s)", tmpPath, err, sanitizeDiagnosticOutput(string(out)))
	}

	// 4. Write secret bytes to the already-secured file
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to write secret data to %s: %w", tmpPath, err)
	}

	// 5. Safe atomic replacement preserving existing target if replacement fails
	if _, statErr := os.Stat(targetPath); statErr == nil {
		bakPath := fmt.Sprintf("%s.bak.%d", targetPath, time.Now().UnixNano())
		if err := os.Rename(targetPath, bakPath); err != nil {
			_ = os.Remove(tmpPath)
			return fmt.Errorf("failed to backup existing config %s to %s: %w", targetPath, bakPath, err)
		}
		if err := os.Rename(tmpPath, targetPath); err != nil {
			// Restore backup immediately so working configuration is never lost
			_ = os.Rename(bakPath, targetPath)
			_ = os.Remove(tmpPath)
			return fmt.Errorf("failed to rename new config into place; restored original: %w", err)
		}
		_ = os.Remove(bakPath)
	} else {
		if err := os.Rename(tmpPath, targetPath); err != nil {
			_ = os.Remove(tmpPath)
			return fmt.Errorf("failed to rename new config to %s: %w", targetPath, err)
		}
	}

	return nil
}

func findWindowsWireGuardExecutables() (wireguardExe string, wgExe string, err error) {
	searchPaths := []string{
		filepath.Join(os.Getenv("ProgramFiles"), "WireGuard"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "WireGuard"),
		`C:\Program Files\WireGuard`,
		`C:\Program Files (x86)\WireGuard`,
	}

	for _, dir := range searchPaths {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, "wireguard.exe")
		if _, statErr := os.Stat(candidate); statErr == nil {
			wireguardExe = candidate
			break
		}
	}

	if wireguardExe == "" {
		if path, lookErr := exec.LookPath("wireguard.exe"); lookErr == nil {
			wireguardExe = path
		}
	}

	for _, dir := range searchPaths {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, "wg.exe")
		if _, statErr := os.Stat(candidate); statErr == nil {
			wgExe = candidate
			break
		}
	}

	if wgExe == "" {
		if path, lookErr := exec.LookPath("wg.exe"); lookErr == nil {
			wgExe = path
		}
	}

	// Distinct capability verification: require wireguard.exe for service management and wg.exe for dump
	if wireguardExe == "" {
		return "", "", errors.New("wireguard.exe not found in Program Files or PATH; required for tunnel service management")
	}
	if wgExe == "" {
		return "", "", errors.New("wg.exe not found in Program Files or PATH; required for dump observation")
	}

	return wireguardExe, wgExe, nil
}

func (b *windowsBackend) DetectTools() error {
	_, _, err := findWindowsWireGuardExecutables()
	return err
}

func (b *windowsBackend) ConfigureInterface(ctx context.Context, confPath string, desired Desired) error {
	wireguardExe, _, err := findWindowsWireGuardExecutables()
	if err != nil {
		return err
	}

	absConfPath, err := filepath.Abs(confPath)
	if err != nil {
		return fmt.Errorf("resolve abs conf path error: %w", err)
	}

	// Install tunnel service: wireguard.exe /installtunnelservice <absConfPath>
	_, err = b.runner.Run(ctx, wireguardExe, "/installtunnelservice", absConfPath)
	return err
}

func (b *windowsBackend) RemoveInterface(ctx context.Context, ifaceName string) error {
	if ifaceName != DefaultInterfaceName {
		return fmt.Errorf("%w: refusing to remove non-proxyfleet interface %s", ErrForeignOwnership, ifaceName)
	}

	wireguardExe, _, err := findWindowsWireGuardExecutables()
	if err != nil {
		return err
	}

	// Uninstall tunnel service: wireguard.exe /uninstalltunnelservice <ifaceName>
	_, err = b.runner.Run(ctx, wireguardExe, "/uninstalltunnelservice", ifaceName)
	return err
}

func (b *windowsBackend) ReadDump(ctx context.Context, ifaceName string) (string, error) {
	_, wgExe, err := findWindowsWireGuardExecutables()
	if err != nil {
		return "", err
	}

	// wg.exe show <ifaceName> dump
	return b.runner.Run(ctx, wgExe, "show", ifaceName, "dump")
}

func (b *windowsBackend) RestartInterface(ctx context.Context, confPath string, desired Desired) error {
	if err := b.RemoveInterface(ctx, desired.InterfaceName); err != nil {
		// Log or report removal error, do not silently ignore
		return fmt.Errorf("failed to stop existing tunnel service: %w", err)
	}
	time.Sleep(500 * time.Millisecond)
	return b.ConfigureInterface(ctx, confPath, desired)
}
