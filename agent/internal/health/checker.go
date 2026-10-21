package health

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Status string

const (
	StatusHealthy     Status = "healthy"
	StatusDegraded    Status = "degraded"
	StatusOffline     Status = "offline"
	StatusRouteLeak   Status = "route_leak"
	StatusAuthError   Status = "auth_error"
	StatusTimeout     Status = "timeout"
	StatusConfigError Status = "configuration_error"
)

type Result struct {
	Status       Status
	ExitIP       string
	LatencyMs    int64
	ErrorMessage string
}

type Checker struct {
	timeout time.Duration
}

func NewChecker(timeout time.Duration) *Checker {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &Checker{timeout: timeout}
}

// CheckPort (Layer 2) tests if TCP socket is accepting connections
func (c *Checker) CheckPort(ctx context.Context, ip string, port int) error {
	addr := net.JoinHostPort(ip, strconv.Itoa(port))
	dialer := net.Dialer{Timeout: c.timeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	conn.Close()
	return nil
}

// EvaluateEgress detects route leak when actual exit IP differs from expected egress IP
func (c *Checker) EvaluateEgress(expectedIP, actualIP string) Status {
	if expectedIP == "" || actualIP == "" {
		return StatusHealthy
	}
	if expectedIP != actualIP {
		return StatusRouteLeak
	}
	return StatusHealthy
}

// CheckHttpProxy executes an authenticated CONNECT request through the proxy, measures latency,
// captures exit public IP, and verifies against expected egress to detect route leaks.
func (c *Checker) CheckHttpProxy(
	ctx context.Context,
	proxyHost string,
	proxyPort int,
	username, password string,
	targetURL string,
	expectedEgressIP string,
) Result {
	start := time.Now()
	addr := net.JoinHostPort(proxyHost, strconv.Itoa(proxyPort))

	dialer := net.Dialer{Timeout: c.timeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return Result{
			Status:       StatusOffline,
			ErrorMessage: err.Error(),
		}
	}
	defer conn.Close()

	targetHost := "api.ipify.org:80"
	if targetURL != "" {
		trimmed := strings.TrimPrefix(targetURL, "http://")
		trimmed = strings.TrimPrefix(trimmed, "https://")
		trimmed = strings.TrimRight(trimmed, "/")
		if !strings.Contains(trimmed, ":") {
			trimmed += ":80"
		}
		targetHost = trimmed
	}

	connectReq := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n", targetHost, targetHost)
	if username != "" || password != "" {
		cred := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
		connectReq += fmt.Sprintf("Proxy-Authorization: Basic %s\r\n", cred)
	}
	connectReq += "\r\n"

	if _, err := conn.Write([]byte(connectReq)); err != nil {
		return Result{
			Status:       StatusOffline,
			ErrorMessage: fmt.Sprintf("write connect error: %v", err),
		}
	}

	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		return Result{
			Status:       StatusOffline,
			ErrorMessage: fmt.Sprintf("read connect response error: %v", err),
		}
	}
	resp.Body.Close()

	if resp.StatusCode == http.StatusProxyAuthRequired {
		return Result{
			Status:       StatusAuthError,
			ErrorMessage: "407 Proxy Authentication Required",
		}
	}
	if resp.StatusCode != http.StatusOK {
		return Result{
			Status:       StatusConfigError,
			ErrorMessage: fmt.Sprintf("proxy CONNECT returned status %d", resp.StatusCode),
		}
	}

	getReq := fmt.Sprintf("GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", targetHost)
	if _, err := conn.Write([]byte(getReq)); err != nil {
		return Result{
			Status:       StatusDegraded,
			ErrorMessage: fmt.Sprintf("write GET request error: %v", err),
		}
	}

	targetResp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		return Result{
			Status:       StatusDegraded,
			ErrorMessage: fmt.Sprintf("read GET response error: %v", err),
		}
	}
	defer targetResp.Body.Close()

	bodyBytes, err := io.ReadAll(io.LimitReader(targetResp.Body, 1024))
	if err != nil {
		return Result{
			Status:       StatusDegraded,
			ErrorMessage: fmt.Sprintf("read body error: %v", err),
		}
	}

	exitIP := strings.TrimSpace(string(bodyBytes))
	latency := time.Since(start).Milliseconds()
	if latency <= 0 {
		latency = 1
	}
	if expectedEgressIP != "" && exitIP != expectedEgressIP {
		return Result{
			Status:       StatusRouteLeak,
			ExitIP:       exitIP,
			LatencyMs:    latency,
			ErrorMessage: fmt.Sprintf("route leak detected: expected exit IP %s, got %s", expectedEgressIP, exitIP),
		}
	}

	status := StatusHealthy
	if latency > 1500 {
		status = StatusDegraded
	}

	return Result{
		Status:    status,
		ExitIP:    exitIP,
		LatencyMs: latency,
	}
}
