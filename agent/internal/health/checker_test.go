package health_test

import (
	"context"
	"net"
	"testing"
	"time"

	"proxyfleet/agent/internal/health"
)

func TestCheckerPortAndEgressEvaluation(t *testing.T) {
	// Start a dummy listener
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}
	defer l.Close()

	port := l.Addr().(*net.TCPAddr).Port

	checker := health.NewChecker(2 * time.Second)
	ctx := context.Background()

	// 1. Port open check
	if err := checker.CheckPort(ctx, "127.0.0.1", port); err != nil {
		t.Errorf("expected port open, got error: %v", err)
	}

	// 2. Closed port check
	if err := checker.CheckPort(ctx, "127.0.0.1", 1); err == nil {
		t.Errorf("expected error on closed port, got nil")
	}

	// 3. Egress leak check
	leakStatus := checker.EvaluateEgress("1.1.1.1", "2.2.2.2")
	if leakStatus != health.StatusRouteLeak {
		t.Errorf("expected route_leak, got %s", leakStatus)
	}

	healthyStatus := checker.EvaluateEgress("1.1.1.1", "1.1.1.1")
	if healthyStatus != health.StatusHealthy {
		t.Errorf("expected healthy, got %s", healthyStatus)
	}
}
