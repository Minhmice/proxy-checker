package config_test

import (
	"os"
	"testing"

	"proxyfleet/agent/internal/config"
	"proxyfleet/agent/internal/controller"
	"proxyfleet/agent/internal/wireguard"
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

func TestConfigAgentTokenPersistence(t *testing.T) {
	dir := t.TempDir()
	mgr := config.NewManager(dir)

	state := &config.State{
		ServerURL:    "https://control.example.com",
		NodeID:       "node-auth-1",
		NodeName:     "worker-auth-1",
		WireGuardIP:  "10.77.0.50",
		AgentToken:   "fla_abc123def456",
		LastRevision: 42,
	}

	if err := mgr.Save(state); err != nil {
		t.Fatalf("save error: %v", err)
	}

	loaded, err := mgr.Load()
	if err != nil {
		t.Fatalf("load error: %v", err)
	}

	if loaded.AgentToken != "fla_abc123def456" {
		t.Errorf("expected AgentToken fla_abc123def456, got %s", loaded.AgentToken)
	}
	if loaded.LastRevision != 42 {
		t.Errorf("expected LastRevision 42, got %d", loaded.LastRevision)
	}
}

func TestConfigLegacyStateWithoutAgentToken(t *testing.T) {
	dir := t.TempDir()
	mgr := config.NewManager(dir)

	// Simulate legacy state.json written before AgentToken field existed
	legacyJSON := []byte(`{
  "server_url": "https://control.example.com",
  "node_id": "legacy-node-77",
  "node_name": "legacy-worker",
  "wireguard_ip": "10.77.0.77",
  "last_revision": 100
}`)
	statePath := mgr.StateFilePath()
	if err := os.WriteFile(statePath, legacyJSON, 0600); err != nil {
		t.Fatalf("failed to write legacy state: %v", err)
	}

	loaded, err := mgr.Load()
	if err != nil {
		t.Fatalf("load legacy error: %v", err)
	}

	if loaded.NodeID != "legacy-node-77" {
		t.Errorf("expected legacy-node-77, got %s", loaded.NodeID)
	}
	if loaded.AgentToken != "" {
		t.Errorf("expected empty AgentToken for legacy state, got %s", loaded.AgentToken)
	}
	if loaded.LastRevision != 100 {
		t.Errorf("expected LastRevision 100, got %d", loaded.LastRevision)
	}
}

func TestConfigPendingReportPersistence(t *testing.T) {
	dir := t.TempDir()
	mgr := config.NewManager(dir)

	state := &config.State{
		ServerURL:    "https://control.example.com",
		NodeID:       "node-persist-pending",
		AgentToken:   "fla_token_persist",
		LastRevision: 50,
		PendingReport: &controller.DeploymentResultRequest{
			NodeID:       "node-persist-pending",
			Revision:     50,
			ConfigDigest: "sha256:abc123digest",
			Status:       "applied",
			ErrorMessage: "",
		},
	}

	if err := mgr.Save(state); err != nil {
		t.Fatalf("save error: %v", err)
	}

	loaded, err := mgr.Load()
	if err != nil {
		t.Fatalf("load error: %v", err)
	}

	if loaded.PendingReport == nil {
		t.Fatalf("expected non-nil PendingReport")
	}
	if loaded.PendingReport.NodeID != "node-persist-pending" {
		t.Errorf("expected PendingReport.NodeID node-persist-pending, got %s", loaded.PendingReport.NodeID)
	}
	if loaded.PendingReport.Revision != 50 {
		t.Errorf("expected PendingReport.Revision 50, got %d", loaded.PendingReport.Revision)
	}
	if loaded.PendingReport.ConfigDigest != "sha256:abc123digest" {
		t.Errorf("expected PendingReport.ConfigDigest sha256:abc123digest, got %s", loaded.PendingReport.ConfigDigest)
	}
	if loaded.PendingReport.Status != "applied" {
		t.Errorf("expected PendingReport.Status applied, got %s", loaded.PendingReport.Status)
	}
}

func TestConfigWireGuardMetadataPersistence(t *testing.T) {
	dir := t.TempDir()
	mgr := config.NewManager(dir)

	state := &config.State{
		NodeID:                   "node-wg-test",
		WireGuardIP:              "10.77.0.15",
		WireGuardPublicKey:       "client-pub-key-wg",
		WireGuardPrivateKey:      "client-priv-key-wg",
		ServerWireGuardPublicKey: "server-pub-key-wg",
		ServerWireGuardEndpoint:  "192.168.1.1:51820",
		AgentVersion:             "0.2.0",
		WireGuard: &wireguard.Desired{
			InterfaceName:              "proxyfleet",
			AddressCIDR:                "10.77.0.15/24",
			ControllerPublicKey:        "server-pub-key-wg",
			ControllerEndpoint:         "192.168.1.1:51820",
			AllowedIPs:                 []string{"10.77.0.0/24"},
			PersistentKeepaliveSeconds: 25,
		},
	}

	if err := mgr.Save(state); err != nil {
		t.Fatalf("save error: %v", err)
	}

	loaded, err := mgr.Load()
	if err != nil {
		t.Fatalf("load error: %v", err)
	}

	if loaded.ServerWireGuardPublicKey != "server-pub-key-wg" {
		t.Errorf("expected ServerWireGuardPublicKey preserved, got %s", loaded.ServerWireGuardPublicKey)
	}
	if loaded.ServerWireGuardEndpoint != "192.168.1.1:51820" {
		t.Errorf("expected ServerWireGuardEndpoint preserved, got %s", loaded.ServerWireGuardEndpoint)
	}
	if loaded.AgentVersion != "0.2.0" {
		t.Errorf("expected AgentVersion 0.2.0, got %s", loaded.AgentVersion)
	}
	if loaded.WireGuard == nil || loaded.WireGuard.InterfaceName != "proxyfleet" {
		t.Fatalf("expected loaded WireGuard desired config preserved, got %+v", loaded.WireGuard)
	}
	if loaded.WireGuard.AddressCIDR != "10.77.0.15/24" {
		t.Errorf("expected AddressCIDR 10.77.0.15/24, got %s", loaded.WireGuard.AddressCIDR)
	}
}
