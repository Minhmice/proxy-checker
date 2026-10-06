package config_test

import (
	"testing"

	"proxyfleet/agent/internal/config"
)

func TestConfigSaveAndLoad(t *testing.T) {
	dir := t.TempDir()
	mgr := config.NewManager(dir)

	initial, err := mgr.Load()
	if err != nil {
		t.Fatalf("load empty error: %v", err)
	}
	if initial.NodeID != "" {
		t.Errorf("expected empty NodeID, got %s", initial.NodeID)
	}

	state := &config.State{
		ServerURL:   "https://control.example.com",
		NodeID:      "node-999",
		NodeName:    "worker-999",
		WireGuardIP: "10.77.0.99",
	}

	if err := mgr.Save(state); err != nil {
		t.Fatalf("save error: %v", err)
	}

	loaded, err := mgr.Load()
	if err != nil {
		t.Fatalf("load saved error: %v", err)
	}

	if loaded.NodeID != "node-999" || loaded.WireGuardIP != "10.77.0.99" {
		t.Errorf("unexpected loaded state: %+v", loaded)
	}
}
