package proxy

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

type Deployer struct {
	configPath   string
	backupPath   string
	reloadCmd    string
	isCustomExec bool
	execCommand  func(name string, arg ...string) error
}
func NewDeployer(configPath string) *Deployer {
	return &Deployer{
		configPath: configPath,
		backupPath: configPath + ".bak",
		reloadCmd:  "3proxy",
		execCommand: func(name string, arg ...string) error {
			cmd := exec.Command(name, arg...)
			return cmd.Run()
		},
	}
}

func (d *Deployer) SetExecCommand(fn func(name string, arg ...string) error) {
	d.execCommand = fn
	d.isCustomExec = true
}

func (d *Deployer) Apply(content string) error {
	dir := filepath.Dir(d.configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir error: %w", err)
	}

	// 1. Backup existing config if exists
	hasExisting := false
	if existingBytes, err := os.ReadFile(d.configPath); err == nil {
		hasExisting = true
		if err := os.WriteFile(d.backupPath, existingBytes, 0600); err != nil {
			return fmt.Errorf("write backup error: %w", err)
		}
	}

	// 2. Write to temp file in same directory
	tempFile := d.configPath + ".tmp"
	if err := os.WriteFile(tempFile, []byte(content), 0600); err != nil {
		return fmt.Errorf("write temp config error: %w", err)
	}

	// 3. Atomic rename
	if err := os.Rename(tempFile, d.configPath); err != nil {
		os.Remove(tempFile)
		return fmt.Errorf("atomic rename error: %w", err)
	}

	// 4. Trigger service reload / restart
	if err := d.reloadService(); err != nil {
		// Rollback immediately
		d.Rollback(hasExisting)
		return fmt.Errorf("reload failed, rolled back to previous config: %w", err)
	}

	return nil
}

func (d *Deployer) Rollback(hasExisting bool) {
	if hasExisting {
		if backupBytes, err := os.ReadFile(d.backupPath); err == nil {
			_ = os.WriteFile(d.configPath, backupBytes, 0600)
			_ = d.reloadService()
		}
	} else {
		_ = os.Remove(d.configPath)
		_ = d.reloadService()
	}
}

func (d *Deployer) reloadService() error {
	if d.isCustomExec {
		return d.execCommand("systemctl", "reload-or-restart", d.reloadCmd)
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		// Non-systemd environment (Windows, dev, OpenWrt procd): bypass systemctl reload
		return nil
	}
	return d.execCommand("systemctl", "reload-or-restart", d.reloadCmd)
}
