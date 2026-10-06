package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	baseURL    string
	httpClient *http.Client
}

type EnrollRequest struct {
	Token              string `json:"token"`
	NodeName           string `json:"nodeName"`
	WireguardPublicKey string `json:"wireguardPublicKey"`
	PublicIP           string `json:"publicIp,omitempty"`
	OS                 string `json:"os,omitempty"`
	Arch               string `json:"arch,omitempty"`
	AgentVersion       string `json:"agentVersion,omitempty"`
}

type EnrollResponse struct {
	NodeID                   string `json:"nodeId"`
	NodeName                 string `json:"nodeName"`
	WireGuardIP              string `json:"wireguardIp"`
	ServerWireguardPublicKey string `json:"serverWireguardPublicKey"`
	ServerWireguardEndpoint  string `json:"serverWireguardEndpoint"`
}

type HeartbeatRequest struct {
	NodeID       string  `json:"nodeId"`
	Status       string  `json:"status"`
	CPUUsage     float64 `json:"cpuUsage,omitempty"`
	MemoryUsage  float64 `json:"memoryUsage,omitempty"`
	PublicIP     string  `json:"publicIp,omitempty"`
	AgentVersion string  `json:"agentVersion,omitempty"`
}

type ProxyEndpointConfig struct {
	ID              string `json:"id"`
	NodeID          string `json:"node_id"`
	Protocol        string `json:"protocol"`
	ListenIP        string `json:"listen_ip"`
	ListenPort      int    `json:"listen_port"`
	Username        string `json:"username"`
	Password        string `json:"password"`
	Enabled         bool   `json:"enabled"`
	CurrentRevision int    `json:"current_revision"`
}

type DesiredStateResponse struct {
	Revision int64                 `json:"revision"`
	Proxies  []ProxyEndpointConfig `json:"proxies"`
}

type DeploymentResultRequest struct {
	NodeID       string `json:"nodeId"`
	Revision     int64  `json:"revision"`
	ConfigDigest string `json:"configDigest"`
	Status       string `json:"status"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

func NewClient(baseURL string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	trimmed := strings.TrimRight(baseURL, "/")
	return &Client{
		baseURL: trimmed,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

func (c *Client) postJSON(ctx context.Context, endpoint string, payload interface{}, target interface{}) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload error: %w", err)
	}

	reqURL := fmt.Sprintf("%s%s", c.baseURL, endpoint)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, reqURL, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("create request error: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("http request error: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
	if err != nil {
		return fmt.Errorf("read response error: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("server error status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	if target != nil {
		if err := json.Unmarshal(bodyBytes, target); err != nil {
			return fmt.Errorf("decode response error: %w", err)
		}
	}
	return nil
}

func (c *Client) Enroll(ctx context.Context, req EnrollRequest) (*EnrollResponse, error) {
	var resp EnrollResponse
	if err := c.postJSON(ctx, "/api/fleet/enroll", req, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

func (c *Client) SendHeartbeat(ctx context.Context, req HeartbeatRequest) error {
	return c.postJSON(ctx, "/api/fleet/agent/heartbeat", req, nil)
}

func (c *Client) GetDesiredState(ctx context.Context, nodeID string) (*DesiredStateResponse, error) {
	reqURL := fmt.Sprintf("%s/api/fleet/agent/desired-state?nodeId=%s", c.baseURL, nodeID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create request error: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request error: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("read response error: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var state DesiredStateResponse
	if err := json.Unmarshal(bodyBytes, &state); err != nil {
		return nil, fmt.Errorf("decode desired state error: %w", err)
	}
	return &state, nil
}

func (c *Client) ReportDeploymentResult(ctx context.Context, req DeploymentResultRequest) error {
	return c.postJSON(ctx, "/api/fleet/agent/deployment-result", req, nil)
}
