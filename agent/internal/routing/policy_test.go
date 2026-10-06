package routing_test

import (
	"strings"
	"testing"

	"proxyfleet/agent/internal/routing"
)

func TestPolicyRoutingCommandExecution(t *testing.T) {
	router := routing.NewRouter()
	var executed [][]string

	router.SetExecCommand(func(name string, arg ...string) error {
		executed = append(executed, append([]string{name}, arg...))
		return nil
	})

	err := router.EnsureEgressPolicy("eth1", 101, "192.168.1.1", "192.168.1.100")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// On non-linux (e.g. windows test run), EnsureEgressPolicy returns nil safely
	// If executed on Linux, it will issue ip route replace and ip rule add
	for _, cmd := range executed {
		line := strings.Join(cmd, " ")
		if !strings.HasPrefix(line, "ip ") {
			t.Errorf("unexpected command: %s", line)
		}
	}
}
