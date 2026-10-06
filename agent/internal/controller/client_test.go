package controller_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"proxyfleet/agent/internal/controller"
)

func TestClientEnrollmentAndHeartbeat(t *testing.T) {
	var receivedToken string
	var receivedHeartbeatNodeId string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		if r.URL.Path == "/api/fleet/enroll" {
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
			})
			return
		}

		if r.URL.Path == "/api/fleet/agent/heartbeat" {
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
	if receivedToken != "test-token-flt" {
		t.Errorf("Server did not receive token, got %s", receivedToken)
	}

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
	if len(desired.Proxies) != 1 || desired.Proxies[0].ListenPort != 20001 {
		t.Errorf("Unexpected proxies payload: %+v", desired.Proxies)
	}
}
