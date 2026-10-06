package proxy_test

import (
	"errors"
	"os"
	"path/filepath"
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
