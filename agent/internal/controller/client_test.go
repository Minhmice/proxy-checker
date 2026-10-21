package controller_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"proxyfleet/agent/internal/controller"
)

func TestClientEnrollmentAndHeartbeat(t *testing.T) {
	var receivedToken string
	var receivedHeartbeatNodeId string
	var enrollAuthHeader string
	var heartbeatAuthHeader string
	var desiredStateAuthHeader string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if r.URL.Path == "/api/fleet/enroll" {
			enrollAuthHeader = r.Header.Get("Authorization")
			var body struct {
				Token              string `json:"token"`
				NodeName           string `json:"nodeName"`
				WireguardPublicKey string `json:"wireguardPublicKey"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			receivedToken = body.Token

			json.NewEncoder(w).Encode(map[string]interface{}{
				"nodeId":                   "node-12345",
				"nodeName":                 body.NodeName,
				"wireguardIp":              "10.77.0.11",
				"serverWireguardPublicKey": "mock-server-wg-key",
				"serverWireguardEndpoint":  "127.0.0.1:51820",
				"agentToken":               "fla_mock_agent_token_xyz",
			})
			return
		}

		if r.URL.Path == "/api/fleet/agent/heartbeat" {
			heartbeatAuthHeader = r.Header.Get("Authorization")
			var body struct {
				NodeID string `json:"nodeId"`
				Status string `json:"status"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			receivedHeartbeatNodeId = body.NodeID
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
			return
		}

		if r.URL.Path == "/api/fleet/agent/desired-state" {
			desiredStateAuthHeader = r.Header.Get("Authorization")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"revision": 100,
				"proxies": []map[string]interface{}{
					{
						"id":          "ep-1",
						"protocol":    "http",
						"listen_ip":   "10.77.0.11",
						"listen_port": 20001,
						"username":    "user1",
						"password":    "pass1",
					},
				},
			})
			return
		}

		http.NotFound(w, r)
	}))
	defer server.Close()

	client := controller.NewClient(server.URL, 5*time.Second)
	ctx := context.Background()

	// 1. Test Enrollment
	enrollRes, err := client.Enroll(ctx, controller.EnrollRequest{
		Token:              "test-token-flt",
		NodeName:           "worker-001",
		WireguardPublicKey: "client-pub-key-123",
		OS:                 "Ubuntu 24.04",
		Arch:               "amd64",
		AgentVersion:       "0.1.0",
	})
	if err != nil {
		t.Fatalf("Enroll failed: %v", err)
	}
	if enrollRes.NodeID != "node-12345" {
		t.Errorf("Expected node-12345, got %s", enrollRes.NodeID)
	}
	if enrollRes.WireGuardIP != "10.77.0.11" {
		t.Errorf("Expected 10.77.0.11, got %s", enrollRes.WireGuardIP)
	}
	if enrollRes.AgentToken != "fla_mock_agent_token_xyz" {
		t.Errorf("Expected fla_mock_agent_token_xyz, got %s", enrollRes.AgentToken)
	}
	if enrollAuthHeader != "" {
		t.Errorf("Expected empty Authorization header during enrollment, got %s", enrollAuthHeader)
	}
	if receivedToken != "test-token-flt" {
		t.Errorf("Server did not receive token, got %s", receivedToken)
	}

	// Configure client with received token
	client.SetAgentToken(enrollRes.AgentToken)
	// 2. Test Heartbeat
	err = client.SendHeartbeat(ctx, controller.HeartbeatRequest{
		NodeID:       enrollRes.NodeID,
		Status:       "online",
		CPUUsage:     12.5,
		MemoryUsage:  34.2,
		AgentVersion: "0.1.0",
	})
	if err != nil {
		t.Fatalf("Heartbeat failed: %v", err)
	}
	if heartbeatAuthHeader != "Bearer fla_mock_agent_token_xyz" {
		t.Errorf("Expected Bearer fla_mock_agent_token_xyz, got %s", heartbeatAuthHeader)
	}
	if receivedHeartbeatNodeId != "node-12345" {
		t.Errorf("Server received wrong heartbeat node ID: %s", receivedHeartbeatNodeId)
	}
	// 3. Test Desired State
	desired, err := client.GetDesiredState(ctx, enrollRes.NodeID)
	if err != nil {
		t.Fatalf("GetDesiredState failed: %v", err)
	}
	if desired.Revision != 100 {
		t.Errorf("Expected revision 100, got %d", desired.Revision)
	}
	if desiredStateAuthHeader != "Bearer fla_mock_agent_token_xyz" {
		t.Errorf("Expected Bearer fla_mock_agent_token_xyz for desired state, got %s", desiredStateAuthHeader)
	}
	if len(desired.Proxies) != 1 || desired.Proxies[0].ListenPort != 20001 {
		t.Errorf("Unexpected proxies payload: %+v", desired.Proxies)
	}
}

func TestClientEnrollRejectsMissingAgentToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Response without agentToken
		json.NewEncoder(w).Encode(map[string]interface{}{
			"nodeId":                   "node-missing-token",
			"nodeName":                 "worker-bad",
			"wireguardIp":              "10.77.0.99",
			"serverWireguardPublicKey": "mock-pubkey",
			"serverWireguardEndpoint":  "127.0.0.1:51820",
		})
	}))
	defer server.Close()

	client := controller.NewClient(server.URL, 5*time.Second)
	_, err := client.Enroll(context.Background(), controller.EnrollRequest{
		Token:    "valid-token",
		NodeName: "worker-bad",
	})
	if err == nil {
		t.Fatalf("Expected Enroll to fail when agentToken is missing in response, but it succeeded")
	}
}

func TestClientAuthorizationScopingAcrossRoutes(t *testing.T) {
	headers := make(map[string]string)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers[r.URL.Path] = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/fleet/enroll":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"nodeId":     "node-scope",
				"agentToken": "issued-token",
			})
		case "/api/fleet/agent/heartbeat", "/api/fleet/agent/deployment-result":
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true}`))
		case "/api/fleet/agent/desired-state":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"revision": 1,
				"proxies":  []interface{}{},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken("pre-set-credential")
	ctx := context.Background()

	// 1. Enroll should NOT send Authorization header even if agentToken was set
	_, _ = client.Enroll(ctx, controller.EnrollRequest{Token: "tok", NodeName: "n"})
	if headers["/api/fleet/enroll"] != "" {
		t.Errorf("Expected empty Authorization for enroll, got: %s", headers["/api/fleet/enroll"])
	}

	// 2. Heartbeat MUST send Authorization Bearer
	_ = client.SendHeartbeat(ctx, controller.HeartbeatRequest{NodeID: "node-scope", Status: "online"})
	if headers["/api/fleet/agent/heartbeat"] != "Bearer pre-set-credential" {
		t.Errorf("Expected Bearer pre-set-credential for heartbeat, got: %s", headers["/api/fleet/agent/heartbeat"])
	}

	// 3. DesiredState MUST send Authorization Bearer
	_, _ = client.GetDesiredState(ctx, "node-scope")
	if headers["/api/fleet/agent/desired-state"] != "Bearer pre-set-credential" {
		t.Errorf("Expected Bearer pre-set-credential for desired-state, got: %s", headers["/api/fleet/agent/desired-state"])
	}

	// 4. DeploymentResult MUST send Authorization Bearer
	_ = client.ReportDeploymentResult(ctx, controller.DeploymentResultRequest{NodeID: "node-scope", Revision: 1, Status: "applied"})
	if headers["/api/fleet/agent/deployment-result"] != "Bearer pre-set-credential" {
		t.Errorf("Expected Bearer pre-set-credential for deployment-result, got: %s", headers["/api/fleet/agent/deployment-result"])
	}
}

func TestGetDesiredStateNetworkFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	serverURL := server.URL
	server.Close()

	client := controller.NewClient(serverURL, 500*time.Millisecond)
	client.SetAgentToken("dummy-network-test-token")
	_, err := client.GetDesiredState(context.Background(), "node-fail")
	if err == nil {
		t.Fatalf("expected error from GetDesiredState on closed server, got nil")
	}
	if !strings.Contains(err.Error(), "http request error") {
		t.Errorf("expected wrapped http request error, got: %v", err)
	}
}

func TestAuthenticatedRoutesRejectMissingTokenWithoutNetwork(t *testing.T) {
	networkHits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		networkHits++
		http.Error(w, "should not be reached", http.StatusInternalServerError)
	}))
	defer server.Close()

	client := controller.NewClient(server.URL, 5*time.Second)
	// agentToken is empty by default
	ctx := context.Background()

	errHeartbeat := client.SendHeartbeat(ctx, controller.HeartbeatRequest{NodeID: "node-1", Status: "online"})
	if errHeartbeat == nil || !strings.Contains(errHeartbeat.Error(), "agent token is required") {
		t.Errorf("expected local error on heartbeat with missing token, got: %v", errHeartbeat)
	}

	_, errDesired := client.GetDesiredState(ctx, "node-1")
	if errDesired == nil || !strings.Contains(errDesired.Error(), "agent token is required") {
		t.Errorf("expected local error on desired state with missing token, got: %v", errDesired)
	}

	errDeploy := client.ReportDeploymentResult(ctx, controller.DeploymentResultRequest{NodeID: "node-1", Revision: 1, Status: "applied"})
	if errDeploy == nil || !strings.Contains(errDeploy.Error(), "agent token is required") {
		t.Errorf("expected local error on deployment result with missing token, got: %v", errDeploy)
	}

	if networkHits != 0 {
		t.Errorf("expected 0 network requests on missing agent token, got %d", networkHits)
	}
}

func TestClientRegisterRuntimeSession(t *testing.T) {
	var receivedAuth string
	var receivedReq controller.RuntimeSessionRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/fleet/agent/runtime-session" {
			receivedAuth = r.Header.Get("Authorization")
			if err := json.NewDecoder(r.Body).Decode(&receivedReq); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(controller.RuntimeSessionResponse{
				Accepted:  true,
				SessionID: receivedReq.SessionID,
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken("test-agent-token-xyz")

	resp, err := client.RegisterRuntimeSession(context.Background(), controller.RuntimeSessionRequest{
		NodeID:    "node-abc",
		SessionID: "sess-1234567890123456",
	})
	if err != nil {
		t.Fatalf("RegisterRuntimeSession failed: %v", err)
	}
	if !resp.Accepted {
		t.Errorf("expected Accepted=true, got false")
	}
	if resp.SessionID != "sess-1234567890123456" {
		t.Errorf("expected SessionID sess-1234567890123456, got %s", resp.SessionID)
	}
	if receivedAuth != "Bearer test-agent-token-xyz" {
		t.Errorf("expected Bearer token in auth header, got %s", receivedAuth)
	}
	if receivedReq.NodeID != "node-abc" || receivedReq.SessionID != "sess-1234567890123456" {
		t.Errorf("unexpected request received: %+v", receivedReq)
	}
}

func TestClientDesiredStateParsesCapacityAndWireGuard(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"revision": 105,
			"proxies":  []map[string]interface{}{},
			"capacity": map[string]interface{}{
				"maxConnections": 500,
			},
			"wireguard": map[string]interface{}{
				"interfaceName":              "proxyfleet",
				"addressCidr":                "10.77.0.2/24",
				"controllerPublicKey":        "ctrl-pub-key-base64",
				"controllerEndpoint":         "192.168.1.1:51820",
				"allowedIps":                 []string{"10.77.0.0/24"},
				"persistentKeepaliveSeconds": 25,
			},
		})
	}))
	defer server.Close()

	client := controller.NewClient(server.URL, 5*time.Second)
	client.SetAgentToken("test-agent-token")

	desired, err := client.GetDesiredState(context.Background(), "node-1")
	if err != nil {
		t.Fatalf("GetDesiredState failed: %v", err)
	}
	if desired.Capacity == nil || desired.Capacity.MaxConnections == nil || *desired.Capacity.MaxConnections != 500 {
		t.Errorf("expected Capacity.MaxConnections=500, got %+v", desired.Capacity)
	}
	if desired.WireGuard == nil || desired.WireGuard.InterfaceName != "proxyfleet" {
		t.Errorf("expected WireGuard.InterfaceName=proxyfleet, got %+v", desired.WireGuard)
	}
	if desired.WireGuard.PersistentKeepaliveSeconds != 25 {
		t.Errorf("expected Keepalive 25, got %d", desired.WireGuard.PersistentKeepaliveSeconds)
	}
}
