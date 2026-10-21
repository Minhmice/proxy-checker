package proxy_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"proxyfleet/agent/internal/proxy"
)

func TestDeployerAtomicSwapAndRollback(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "3proxy.cfg")

	// Pre-seed original working config
	origContent := "# Original good config\n"
	if err := os.WriteFile(cfgPath, []byte(origContent), 0600); err != nil {
		t.Fatalf("write original error: %v", err)
	}

	deployer := proxy.NewDeployer(cfgPath)

	// 1. Successful deploy
	deployer.SetExecCommand(func(name string, arg ...string) error {
		return nil // mock success
	})

	newContent := "# Updated good config\n"
	if err := deployer.Apply(newContent); err != nil {
		t.Fatalf("apply failed: %v", err)
	}

	read, _ := os.ReadFile(cfgPath)
	if string(read) != newContent {
		t.Errorf("expected updated content, got: %s", string(read))
	}

	// 2. Failed deploy triggers rollback
	deployer.SetExecCommand(func(name string, arg ...string) error {
		return errors.New("systemd reload failure simulated")
	})

	badContent := "# Bad broken config\n"
	err := deployer.Apply(badContent)
	if err == nil {
		t.Fatalf("expected error on failed reload, got nil")
	}

	// Content must have rolled back to newContent (which was the last known good)
	rolledBack, _ := os.ReadFile(cfgPath)
	if string(rolledBack) != newContent {
		t.Errorf("expected rolled back content, got: %s", string(rolledBack))
	}
}

func TestDeployerRollbackReportsRollbackFailure(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "3proxy.cfg")

	origContent := "# Original good config\n"
	if err := os.WriteFile(cfgPath, []byte(origContent), 0600); err != nil {
		t.Fatalf("write original error: %v", err)
	}

	deployer := proxy.NewDeployer(cfgPath)
	deployer.SetExecCommand(func(name string, arg ...string) error {
		return errors.New("daemon reload crashed completely")
	})

	err := deployer.Apply("# Broken config\n")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}

	// Must report both initial reload error and rollback reload error without swallowing
	errStr := err.Error()
	if !strings.Contains(errStr, "reload failed") {
		t.Errorf("expected 'reload failed' in error, got: %s", errStr)
	}
	if !strings.Contains(errStr, "rollback error") {
		t.Errorf("expected 'rollback error' in error, got: %s", errStr)
	}

	// Config file must still have been restored on disk
	content, _ := os.ReadFile(cfgPath)
	if string(content) != origContent {
		t.Errorf("expected file restored to original, got: %s", string(content))
	}
}

func TestValidateCapacityBudgetBoundary(t *testing.T) {
	config := "maxconn 5\nproxy -p20001 -i127.0.0.1\nsocks -p20002 -i127.0.0.1\n"
	evidence := proxy.BudgetEvidence{SoftLimit: 25, OpenFDs: 3, ConfigPath: "/etc/3proxy.cfg", Verified: true}
	if err := proxy.ValidateCapacity(config, "/etc/3proxy.cfg", evidence); err != nil {
		t.Fatalf("exact budget boundary rejected: %v", err)
	}
	evidence.SoftLimit = 24
	if err := proxy.ValidateCapacity(config, "/etc/3proxy.cfg", evidence); err == nil {
		t.Fatal("over-budget candidate accepted")
	}
	evidence.SoftLimit = 25
	evidence.Verified = false
	if err := proxy.ValidateCapacity(config, "/etc/3proxy.cfg", evidence); err == nil {
		t.Fatal("unknown service evidence accepted")
	}
}


func TestDeployerLeavesDefaultCapacityUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "3proxy.cfg")
	d := proxy.NewDeployer(path)
	d.SetExecCommand(func(string, ...string) error { return nil })
	if err := d.Apply("proxy -p20001 -i127.0.0.1\n"); err != nil { t.Fatalf("default-capacity apply failed: %v", err) }
}
