package health_test

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"proxyfleet/agent/internal/health"
)

// Helper to start a local HTTP CONNECT mock proxy
func startMockHttpProxy(validUser, validPass string, exitIP string) (string, func()) {
	// Target web server returning exitIP
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte(exitIP))
	}))

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}

	go func() {
		for {
			clientConn, err := l.Accept()
			if err != nil {
				return
			}

			go func(c net.Conn) {
				defer c.Close()
				reader := bufio.NewReader(c)
				req, err := http.ReadRequest(reader)
				if err != nil {
					return
				}

				if req.Method == http.MethodConnect {
					authHeader := req.Header.Get("Proxy-Authorization")
					expectedAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte(validUser+":"+validPass))

					if authHeader != expectedAuth {
						c.Write([]byte("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"))
						return
					}

					// Connect to target
					targetConn, err := net.Dial("tcp", targetServer.Listener.Addr().String())
					if err != nil {
						c.Write([]byte("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
						return
					}
					defer targetConn.Close()

					c.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

					// Bi-directional pipe
					go io.Copy(targetConn, c)
					io.Copy(c, targetConn)
				}
			}(clientConn)
		}
	}()

	cleanup := func() {
		l.Close()
		targetServer.Close()
	}

	return l.Addr().String(), cleanup
}

func TestLayer3HttpConnectHealthCheck(t *testing.T) {
	proxyAddr, cleanup := startMockHttpProxy("proxyuser", "secretpass", "203.0.113.55")
	defer cleanup()

	host, portStr, _ := net.SplitHostPort(proxyAddr)
	var port int
	fmt.Sscanf(portStr, "%d", &port)

	checker := health.NewChecker(2 * time.Second)
	ctx := context.Background()

	// 1. Success with correct egress IP
	res := checker.CheckHttpProxy(ctx, host, port, "proxyuser", "secretpass", "http://test-target/", "203.0.113.55")
	if res.Status != health.StatusHealthy {
		t.Errorf("expected healthy status, got %s (err: %s)", res.Status, res.ErrorMessage)
	}
	if res.ExitIP != "203.0.113.55" {
		t.Errorf("expected exit IP 203.0.113.55, got %s", res.ExitIP)
	}
	if res.LatencyMs <= 0 {
		t.Errorf("expected positive latency, got %d", res.LatencyMs)
	}

	// 2. Route leak: actual exit IP (203.0.113.55) differs from expected (198.51.100.1)
	leakRes := checker.CheckHttpProxy(ctx, host, port, "proxyuser", "secretpass", "http://test-target/", "198.51.100.1")
	if leakRes.Status != health.StatusRouteLeak {
		t.Errorf("expected route_leak, got %s", leakRes.Status)
	}

	// 3. Auth error: invalid password
	badAuthRes := checker.CheckHttpProxy(ctx, host, port, "proxyuser", "wrongpassword", "http://test-target/", "")
	if badAuthRes.Status != health.StatusAuthError {
		t.Errorf("expected auth_error, got %s (err: %s)", badAuthRes.Status, badAuthRes.ErrorMessage)
	}

	// 4. Offline: closed port
	offlineRes := checker.CheckHttpProxy(ctx, "127.0.0.1", 1, "u", "p", "http://test-target/", "")
	if offlineRes.Status != health.StatusOffline {
		t.Errorf("expected offline, got %s", offlineRes.Status)
	}
}
