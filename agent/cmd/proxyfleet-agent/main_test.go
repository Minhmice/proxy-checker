package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"proxyfleet/agent/internal/config"
	"proxyfleet/agent/internal/controller"
	"proxyfleet/agent/internal/device"
	"proxyfleet/agent/internal/health"
	"proxyfleet/agent/internal/proxy"
	"proxyfleet/agent/internal/telemetry"
	"proxyfleet/agent/internal/wireguard"
)

func TestSetupStateAndAuthLegacyNodeFailsClosed(t *testing.T) {
	dir := t.TempDir()
	mgr := config.NewManager(dir)

	state := &config.State{
		ServerURL:    "https://control.example.com",
		NodeID:       "node-legacy-99",
		NodeName:     "worker-legacy",
		WireGuardIP:  "10.77.0.99",
		LastRevision: 1500,
		AgentToken:   "", // Missing credential
	}
	if err := mgr.Save(state); err != nil {
		t.Fatalf("save error: %v", err)
	}

	client := controller.NewClient(state.ServerURL, 5*time.Second)

	// Startup without --agent-token must fail closed
	err := setupStateAndAuth(state, mgr, client, "")
	if err == nil {
		t.Fatalf("expected fail closed error when agent_token missing on enrolled node, got nil")
	}

	if !strings.Contains(err.Error(), "node-legacy-99") {
		t.Errorf("expected error to name node, got: %v", err)
	}
	if !strings.Contains(err.Error(), "--agent-token") {
		t.Errorf("expected error to instruct using --agent-token, got: %v", err)
	}
	if !strings.Contains(err.Error(), "POST /api/fleet/nodes/") {
		t.Errorf("expected error to mention admin token route, got: %v", err)
	}

	// Verify state on disk and in memory was NOT reset
	reloaded, err := mgr.Load()
	if err != nil {
		t.Fatalf("reload error: %v", err)
	}
	if reloaded.LastRevision != 1500 {
		t.Errorf("expected LastRevision 1500 preserved, got %d", reloaded.LastRevision)
	}
	if reloaded.NodeID != "node-legacy-99" {
		t.Errorf("expected NodeID node-legacy-99 preserved, got %s", reloaded.NodeID)
	}
}

func TestSetupStateAndAuthProvisionExistingNodeWithAgentTokenFlag(t *testing.T) {
	dir := t.TempDir()
	mgr := config.NewManager(dir)

	state := &config.State{
		ServerURL:    "https://control.example.com",
		NodeID:       "node-legacy-88",
		NodeName:     "worker-legacy-88",
		WireGuardIP:  "10.77.0.88",
		LastRevision: 2000,
		AgentToken:   "",
	}
	if err := mgr.Save(state); err != nil {
		t.Fatalf("save error: %v", err)
	}

	client := controller.NewClient(state.ServerURL, 5*time.Second)

	// Pass rotated/admin-provisioned token via flag
	err := setupStateAndAuth(state, mgr, client, "fla_admin_provisioned_token_88")
	if err != nil {
		t.Fatalf("expected successful provisioning, got error: %v", err)
	}

	if state.AgentToken != "fla_admin_provisioned_token_88" {
		t.Errorf("expected in-memory token updated, got %s", state.AgentToken)
	}
	if state.LastRevision != 2000 {
		t.Errorf("expected LastRevision 2000 preserved, got %d", state.LastRevision)
	}

	// Verify persisted to disk with restrictive state
	reloaded, err := mgr.Load()
	if err != nil {
		t.Fatalf("reload error: %v", err)
	}
	if reloaded.AgentToken != "fla_admin_provisioned_token_88" {
		t.Errorf("expected persisted token fla_admin_provisioned_token_88, got %s", reloaded.AgentToken)
	}
	if reloaded.LastRevision != 2000 {
		t.Errorf("expected persisted LastRevision 2000 preserved, got %d", reloaded.LastRevision)
	}
}

func TestSetupStateAndAuthEnrolledRestart(t *testing.T) {
	dir := t.TempDir()
	mgr := config.NewManager(dir)

	state := &config.State{
		ServerURL:    "https://control.example.com",
		NodeID:       "node-enrolled-1",
		NodeName:     "worker-1",
		WireGuardIP:  "10.77.0.1",
		LastRevision: 50,
		AgentToken:   "fla_valid_existing_token",
	}

	client := controller.NewClient(state.ServerURL, 5*time.Second)

	// Clean restart without flag
	err := setupStateAndAuth(state, mgr, client, "")
	if err != nil {
		t.Fatalf("expected success on restart with valid token, got: %v", err)
	}
}

func TestSetupStateAndAuthUnenrolledNode(t *testing.T) {
	dir := t.TempDir()
	mgr := config.NewManager(dir)

	state := &config.State{
		ServerURL: "https://control.example.com",
		NodeID:    "", // Not yet enrolled
	}

	client := controller.NewClient(state.ServerURL, 5*time.Second)

	// Fresh node proceeds to enrollment phase without error
	err := setupStateAndAuth(state, mgr, client, "")
	if err != nil {
		t.Fatalf("expected nil error for fresh node, got: %v", err)
	}
}

func TestRunCycleDeploysEmptyConfigurationOnHigherRevision(t *testing.T) {
	var heartbeatAuth string
	var desiredStateAuth string
	var reportedResult controller.DeploymentResultRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/agent/heartbeat":
			heartbeatAuth = r.Header.Get("Authorization")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		case "/api/fleet/agent/desired-state":
			desiredStateAuth = r.Header.Get("Authorization")
			// Return higher revision with empty proxies (e.g. disable-last)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"revision": 300,
				"proxies":  []interface{}{},
			})
		case "/api/fleet/agent/deployment-result":
			_ = json.NewDecoder(r.Body).Decode(&reportedResult)
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	mgr := config.NewManager(dir)
	state := &config.State{
		ServerURL:    server.URL,
		NodeID:       "node-empty-deploy",
		NodeName:     "worker-empty",
		WireGuardIP:  "10.77.0.10",
		AgentToken:   "fla_token_empty_test",
		LastRevision: 200,
	}
	if err := mgr.Save(state); err != nil {
		t.Fatalf("save state error: %v", err)
	}

	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken(state.AgentToken)

	proxyCfgPath := filepath.Join(dir, "3proxy.cfg")
	deployer := proxy.NewDeployer(proxyCfgPath)
	checker := health.NewChecker(time.Second)

	ctx := context.Background()
	runCycle(ctx, client, state, mgr, deployer, checker)

	if heartbeatAuth != "Bearer fla_token_empty_test" {
		t.Errorf("expected Bearer fla_token_empty_test on heartbeat, got %s", heartbeatAuth)
	}
	if desiredStateAuth != "Bearer fla_token_empty_test" {
		t.Errorf("expected Bearer fla_token_empty_test on desired state, got %s", desiredStateAuth)
	}

	// Verify revision advanced to 300
	if state.LastRevision != 300 {
		t.Errorf("expected in-memory revision 300, got %d", state.LastRevision)
	}

	reloaded, err := mgr.Load()
	if err != nil {
		t.Fatalf("reload error: %v", err)
	}
	if reloaded.LastRevision != 300 {
		t.Errorf("expected persisted revision 300, got %d", reloaded.LastRevision)
	}

	// Verify deployment result reported as applied
	if reportedResult.Status != "applied" {
		t.Errorf("expected reported status 'applied', got %s", reportedResult.Status)
	}
	if reportedResult.Revision != 300 {
		t.Errorf("expected reported revision 300, got %d", reportedResult.Revision)
	}

	// Verify empty 3proxy.cfg was created/applied
	if _, err := os.Stat(proxyCfgPath); os.IsNotExist(err) {
		t.Errorf("expected 3proxy.cfg to be written")
	}
}

func TestRunCycleSkipsDeploymentWhenRevisionNotNewer(t *testing.T) {
	var deploymentResultReported bool

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/agent/heartbeat":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		case "/api/fleet/agent/desired-state":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"revision": 200, // Same revision as LastRevision
				"proxies":  []interface{}{},
			})
		case "/api/fleet/agent/deployment-result":
			deploymentResultReported = true
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	mgr := config.NewManager(dir)
	state := &config.State{
		ServerURL:    server.URL,
		NodeID:       "node-same-rev",
		AgentToken:   "fla_token_same",
		LastRevision: 200,
	}

	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken(state.AgentToken)

	proxyCfgPath := filepath.Join(dir, "3proxy.cfg")
	deployer := proxy.NewDeployer(proxyCfgPath)
	checker := health.NewChecker(time.Second)

	ctx := context.Background()
	runCycle(ctx, client, state, mgr, deployer, checker)

	if deploymentResultReported {
		t.Errorf("deployment result should not be reported when revision <= LastRevision")
	}
	if state.LastRevision != 200 {
		t.Errorf("expected LastRevision to remain 200, got %d", state.LastRevision)
	}
}

func TestRunCyclePendingReportPersistsOn500AndClearsOnSubsequentCycleWithoutReapplying(t *testing.T) {
	var reportAttempts int
	var reportedStatuses []string
	var reportRevisions []int64

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/agent/heartbeat":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		case "/api/fleet/agent/desired-state":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"revision": 300,
				"proxies":  []interface{}{},
			})
		case "/api/fleet/agent/deployment-result":
			reportAttempts++
			var req controller.DeploymentResultRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			reportedStatuses = append(reportedStatuses, req.Status)
			reportRevisions = append(reportRevisions, req.Revision)

			if reportAttempts == 1 {
				// Controller returns temporary 500 error on first report attempt
				w.WriteHeader(http.StatusInternalServerError)
				w.Write([]byte(`{"error":"temporary database timeout"}`))
				return
			}

			// Controller accepts on retry
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true,"accepted":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	mgr := config.NewManager(dir)
	state := &config.State{
		ServerURL:    server.URL,
		NodeID:       "node-retry-report",
		NodeName:     "worker-retry",
		WireGuardIP:  "10.77.0.15",
		AgentToken:   "fla_token_retry_test",
		LastRevision: 200,
	}
	if err := mgr.Save(state); err != nil {
		t.Fatalf("save state error: %v", err)
	}

	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken(state.AgentToken)

	proxyCfgPath := filepath.Join(dir, "3proxy.cfg")
	deployer := proxy.NewDeployer(proxyCfgPath)
	var applyReloadCount int
	deployer.SetExecCommand(func(name string, arg ...string) error {
		applyReloadCount++
		return nil
	})
	checker := health.NewChecker(time.Second)
	ctx := context.Background()

	// --- Cycle 1: Deploys revision 300, but reporting returns 500 ---
	runCycle(ctx, client, state, mgr, deployer, checker)

	if applyReloadCount != 1 {
		t.Fatalf("expected deployer to reload once on cycle 1, got %d", applyReloadCount)
	}
	if reportAttempts != 1 {
		t.Fatalf("expected 1 report attempt on cycle 1, got %d", reportAttempts)
	}
	if state.LastRevision != 300 {
		t.Errorf("expected in-memory LastRevision 300, got %d", state.LastRevision)
	}
	if state.PendingReport == nil {
		t.Fatalf("expected in-memory PendingReport to be retained after 500 failure")
	}

	// Verify disk persistence after 500 failure
	diskState, err := mgr.Load()
	if err != nil {
		t.Fatalf("failed to load state from disk: %v", err)
	}
	if diskState.LastRevision != 300 {
		t.Errorf("expected persisted LastRevision 300, got %d", diskState.LastRevision)
	}
	if diskState.PendingReport == nil {
		t.Fatalf("expected persisted PendingReport on disk after 500 failure")
	}
	if diskState.PendingReport.Revision != 300 || diskState.PendingReport.Status != "applied" {
		t.Errorf("unexpected persisted pending report: %+v", diskState.PendingReport)
	}

	cfgStatBefore, err := os.Stat(proxyCfgPath)
	if err != nil {
		t.Fatalf("failed to stat 3proxy.cfg: %v", err)
	}

	// --- Simulate agent restart: reload state from disk ---
	restartedState, err := mgr.Load()
	if err != nil {
		t.Fatalf("reload state error: %v", err)
	}

	// --- Cycle 2: Controller returns 200, pending report is delivered and cleared ---
	runCycle(ctx, client, restartedState, mgr, deployer, checker)

	if reportAttempts != 2 {
		t.Fatalf("expected 2 total report attempts across both cycles, got %d", reportAttempts)
	}
	if applyReloadCount != 1 {
		t.Errorf("deployer should NOT have re-applied configuration on cycle 2, got %d reloads", applyReloadCount)
	}

	// Verify config file was not re-written on cycle 2
	cfgStatAfter, err := os.Stat(proxyCfgPath)
	if err != nil {
		t.Fatalf("failed to stat 3proxy.cfg after cycle 2: %v", err)
	}
	if cfgStatAfter.ModTime() != cfgStatBefore.ModTime() {
		t.Errorf("3proxy.cfg modification time changed, config was re-applied unexpectedly")
	}

	// Verify PendingReport was cleared in-memory and on disk
	if restartedState.PendingReport != nil {
		t.Errorf("expected PendingReport to be nil in memory after ACK, got %+v", restartedState.PendingReport)
	}

	reloadedAfterAck, err := mgr.Load()
	if err != nil {
		t.Fatalf("failed to reload state after ACK: %v", err)
	}
	if reloadedAfterAck.PendingReport != nil {
		t.Errorf("expected PendingReport on disk to be cleared after ACK, got %+v", reloadedAfterAck.PendingReport)
	}
	if reloadedAfterAck.LastRevision != 300 {
		t.Errorf("expected persisted LastRevision 300, got %d", reloadedAfterAck.LastRevision)
	}
}

func TestRunCycleSendsDeviceAndRuntimeSnapshotInHeartbeat(t *testing.T) {
	var receivedHeartbeat controller.HeartbeatRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/agent/heartbeat":
			_ = json.NewDecoder(r.Body).Decode(&receivedHeartbeat)
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		case "/api/fleet/agent/runtime-session":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"accepted":true}`))
		case "/api/fleet/agent/desired-state":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"revision": 200, // same revision as state
				"proxies":  []interface{}{},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	mgr := config.NewManager(dir)
	state := &config.State{
		ServerURL:    server.URL,
		NodeID:       "node-runtime-snap-test",
		NodeName:     "worker-test",
		WireGuardIP:  "10.77.0.12",
		AgentToken:   "fla_token_snap_test",
		LastRevision: 200,
	}
	if err := mgr.Save(state); err != nil {
		t.Fatalf("save state error: %v", err)
	}

	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken(state.AgentToken)

	proxyCfgPath := filepath.Join(dir, "3proxy.cfg")
	deployer := proxy.NewDeployer(proxyCfgPath)
	checker := health.NewChecker(time.Second)

	ctx := context.Background()
	runCycle(ctx, client, state, mgr, deployer, checker)

	if receivedHeartbeat.NodeID != "node-runtime-snap-test" {
		t.Errorf("expected NodeID node-runtime-snap-test, got %s", receivedHeartbeat.NodeID)
	}
	if receivedHeartbeat.AgentVersion != Version {
		t.Errorf("expected AgentVersion %s, got %s", Version, receivedHeartbeat.AgentVersion)
	}
	if receivedHeartbeat.Device == nil {
		t.Fatalf("expected non-nil Device info in heartbeat")
	}
	if receivedHeartbeat.Device.SchemaVersion != 1 {
		t.Errorf("expected Device.SchemaVersion=1, got %d", receivedHeartbeat.Device.SchemaVersion)
	}
	if receivedHeartbeat.Runtime == nil {
		t.Fatalf("expected non-nil Runtime snapshot in heartbeat")
	}
	if receivedHeartbeat.Runtime.SchemaVersion != 1 {
		t.Errorf("expected Runtime.SchemaVersion=1, got %d", receivedHeartbeat.Runtime.SchemaVersion)
	}
	if receivedHeartbeat.Runtime.Sequence == 0 {
		t.Errorf("expected positive monotonic sequence, got %d", receivedHeartbeat.Runtime.Sequence)
	}
	if receivedHeartbeat.Runtime.Activity.Kind != "idle" {
		t.Errorf("expected Activity.Kind 'idle', got %s", receivedHeartbeat.Runtime.Activity.Kind)
	}
}

func TestRunCycleAppliesCapacityCeilingFromDesiredState(t *testing.T) {
	var reportedResult controller.DeploymentResultRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/agent/heartbeat":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		case "/api/fleet/agent/runtime-session":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"accepted":true}`))
		case "/api/fleet/agent/desired-state":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"revision": 210,
				"capacity": map[string]interface{}{
					"maxConnections": 350,
				},
				"proxies": []map[string]interface{}{
					{
						"id":               "ep-cap-1",
						"node_id":          "node-cap-test",
						"protocol":         "http",
						"listen_ip":        "127.0.0.1",
						"listen_port":      18080,
						"username":         "usercap",
						"password":         "passcap",
						"enabled":          true,
						"current_revision": 210,
					},
				},
			})
		case "/api/fleet/agent/deployment-result":
			_ = json.NewDecoder(r.Body).Decode(&reportedResult)
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	mgr := config.NewManager(dir)
	state := &config.State{
		ServerURL:    server.URL,
		NodeID:       "node-cap-test",
		NodeName:     "worker-cap",
		AgentToken:   "fla_token_cap_test",
		LastRevision: 200,
	}
	if err := mgr.Save(state); err != nil {
		t.Fatalf("save state error: %v", err)
	}

	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken(state.AgentToken)

	proxyCfgPath := filepath.Join(dir, "3proxy.cfg")
	deployer := proxy.NewDeployer(proxyCfgPath)
	deployer.SetExecCommand(func(name string, arg ...string) error {
		return nil
	})
	checker := health.NewChecker(time.Second)
	ctx := context.Background()
	runCycle(ctx, client, state, mgr, deployer, checker)

	if reportedResult.Status != "failed" {
		t.Fatalf("expected status 'failed' when host capacity evidence is unavailable, got %s", reportedResult.Status)
	}
	if state.LastRevision != 200 {
		t.Errorf("expected LastRevision to remain 200 when capacity cannot be verified, got %d", state.LastRevision)
	}
}

func TestRunCycleFailsDeploymentWhenOverlayProxyMissingWireGuard(t *testing.T) {
	var reportedResult controller.DeploymentResultRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/agent/heartbeat":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		case "/api/fleet/agent/desired-state":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"revision": 220,
				"proxies": []map[string]interface{}{
					{
						"id":               "ep-overlay-fail",
						"node_id":          "node-overlay-fail",
						"protocol":         "http",
						"listen_ip":        "10.77.0.99", // Overlay IP
						"listen_port":      19090,
						"username":         "user1",
						"password":         "pass1",
						"enabled":          true,
						"current_revision": 220,
					},
				},
				// wireguard is explicitly omitted/null
			})
		case "/api/fleet/agent/deployment-result":
			_ = json.NewDecoder(r.Body).Decode(&reportedResult)
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	mgr := config.NewManager(dir)
	state := &config.State{
		ServerURL:    server.URL,
		NodeID:       "node-overlay-fail",
		NodeName:     "worker-overlay",
		AgentToken:   "fla_token_overlay_fail",
		LastRevision: 200,
		WireGuard:    nil, // No wireguard configured
	}
	if err := mgr.Save(state); err != nil {
		t.Fatalf("save state error: %v", err)
	}

	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken(state.AgentToken)

	proxyCfgPath := filepath.Join(dir, "3proxy.cfg")
	deployer := proxy.NewDeployer(proxyCfgPath)
	checker := health.NewChecker(time.Second)

	ctx := context.Background()
	runCycle(ctx, client, state, mgr, deployer, checker)

	// Must honestly report failed deployment without fake success
	if reportedResult.Status != "failed" {
		t.Errorf("expected status 'failed' for overlay proxy missing WireGuard, got %s", reportedResult.Status)
	}
	if !strings.Contains(reportedResult.ErrorMessage, "WireGuard") {
		t.Errorf("expected error message to mention WireGuard, got: %s", reportedResult.ErrorMessage)
	}
	if state.LastRevision != 200 {
		t.Errorf("LastRevision should remain 200 on failure, got %d", state.LastRevision)
	}
}

func TestRunCycleDoesNotPersistUnreconciledWireGuard(t *testing.T) {
	var reportedResult controller.DeploymentResultRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/agent/heartbeat":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		case "/api/fleet/agent/runtime-session":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"accepted":true}`))
		case "/api/fleet/agent/desired-state":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"revision": 230,
				"proxies":  []interface{}{},
				"wireguard": map[string]interface{}{
					"interfaceName":              "proxyfleet",
					"addressCidr":                "10.77.0.50/24",
					"controllerPublicKey":        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
					"controllerEndpoint":         "192.168.1.100:51820",
					"allowedIps":                 []string{"10.77.0.0/24"},
					"persistentKeepaliveSeconds": 25,
				},
			})
		case "/api/fleet/agent/deployment-result":
			_ = json.NewDecoder(r.Body).Decode(&reportedResult)
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	mgr := config.NewManager(dir)
	state := &config.State{
		ServerURL:           server.URL,
		NodeID:              "node-reconcile-wg",
		NodeName:            "worker-wg",
		AgentToken:          "fla_token_reconcile_wg",
		WireGuardPrivateKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
	}
	if err := mgr.Save(state); err != nil {
		t.Fatalf("save state error: %v", err)
	}

	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken(state.AgentToken)

	proxyCfgPath := filepath.Join(dir, "3proxy.cfg")
	deployer := proxy.NewDeployer(proxyCfgPath)
	deployer.SetExecCommand(func(name string, arg ...string) error {
		return nil
	})
	checker := health.NewChecker(time.Second)

	ctx := context.Background()
	runCycle(ctx, client, state, mgr, deployer, checker)

	if reportedResult.Status != "failed" {
		t.Fatalf("expected unprovisioned WireGuard reconcile to report failed, got %q", reportedResult.Status)
	}
	if state.WireGuard != nil {
		t.Fatalf("unreconciled WireGuard must not be persisted in memory: %+v", state.WireGuard)
	}
	reloaded, err := mgr.Load()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.WireGuard != nil {
		t.Fatalf("unreconciled WireGuard must not be persisted: %+v", reloaded.WireGuard)
	}
}

func TestApplyDesiredKeepsHeartbeatLiveAndReportDurable(t *testing.T) {
	deployStarted := make(chan struct{})
	finishDeploy := make(chan struct{})
	reportStarted := make(chan struct{})
	finishReport := make(chan struct{})
	heartbeatSeen := make(chan controller.HeartbeatRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/agent/heartbeat":
			var req controller.HeartbeatRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			heartbeatSeen <- req
			w.WriteHeader(http.StatusOK)
		case "/api/fleet/agent/deployment-result":
			close(reportStarted)
			<-finishReport
			w.WriteHeader(http.StatusOK)
		case "/api/fleet/agent/runtime-session":
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dir := t.TempDir()
	mgr := config.NewManager(dir)
	state := &config.State{ServerURL: server.URL, NodeID: "node-race-test", AgentToken: "fla_race_test"}
	if err := mgr.Save(state); err != nil {
		t.Fatal(err)
	}
	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken(state.AgentToken)
	deployer := proxy.NewDeployer(filepath.Join(dir, "3proxy.cfg"))
	deployer.SetExecCommand(func(string, ...string) error {
		close(deployStarted)
		<-finishDeploy
		return nil
	})
	rt := NewAgentRuntime(client, state, mgr, deployer, health.NewChecker(time.Second), wireguard.NewManager(dir), telemetry.NewCollector(), device.Info{}, "race-session")
	rt.sessionRegistered.Store(true)
	desired := &controller.DesiredStateResponse{Revision: 1, Proxies: []controller.ProxyEndpointConfig{}}
	applyDone := make(chan struct{})
	go func() {
		rt.ApplyDesired(context.Background(), desired)
		close(applyDone)
	}()
	select {
	case <-deployStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("deployment did not start")
	}

	heartbeatDone := make(chan error, 1)
	go func() { heartbeatDone <- rt.SendHeartbeat(context.Background()) }()
	select {
	case err := <-heartbeatDone:
		if err != nil {
			t.Fatalf("heartbeat failed during apply: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("heartbeat blocked behind slow deployment")
	}
	select {
	case heartbeat := <-heartbeatSeen:
		if heartbeat.Runtime == nil || heartbeat.Runtime.Activity.Kind != "applying" || heartbeat.Runtime.Activity.Revision == nil || *heartbeat.Runtime.Activity.Revision != 1 {
			t.Fatalf("heartbeat missed applying state: %+v", heartbeat.Runtime)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("heartbeat request not observed")
	}
	close(finishDeploy)
	select {
	case <-reportStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("deployment result report did not start")
	}
	persisted, err := mgr.Load()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.LastRevision != 1 || persisted.PendingReport == nil || persisted.PendingReport.Status != "applied" {
		t.Fatalf("report was not durably pending before ACK: %+v", persisted)
	}
	close(finishReport)
	select {
	case <-applyDone:
	case <-time.After(5 * time.Second):
		t.Fatal("apply did not finish after report ACK")
	}
	persisted, err = mgr.Load()
	if err != nil {
		t.Fatal(err)
	}
	if persisted.PendingReport != nil {
		t.Fatalf("ACK did not durably clear pending report: %+v", persisted.PendingReport)
	}
}

func TestSendHeartbeatReportsErrorActivityAsDegraded(t *testing.T) {
	var heartbeat controller.HeartbeatRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/fleet/agent/heartbeat" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&heartbeat)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken("fla_error_activity")
	state := &config.State{NodeID: "node-error-activity", AgentToken: "fla_error_activity"}
	rt := NewAgentRuntime(client, state, config.NewManager(t.TempDir()), proxy.NewDeployer(filepath.Join(t.TempDir(), "3proxy.cfg")), health.NewChecker(time.Second), wireguard.NewManager(t.TempDir()), telemetry.NewCollector(), device.Info{}, "error-session")
	rt.sessionRegistered.Store(true)
	message := "deployment failed"
	rt.SetActivity("error", nil, &message)
	if err := rt.SendHeartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if heartbeat.Status != "degraded" {
		t.Fatalf("expected degraded heartbeat for error activity, got %q", heartbeat.Status)
	}
}
