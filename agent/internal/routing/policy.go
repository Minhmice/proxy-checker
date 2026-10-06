package routing

import (
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
)

type Router struct {
	execCommand func(name string, arg ...string) error
}

func NewRouter() *Router {
	return &Router{
		execCommand: func(name string, arg ...string) error {
			cmd := exec.Command(name, arg...)
			return cmd.Run()
		},
	}
}

func (r *Router) SetExecCommand(fn func(name string, arg ...string) error) {
	r.execCommand = fn
}

// EnsureEgressPolicy binds an interface to a specific routing table for multi-WAN isolation
func (r *Router) EnsureEgressPolicy(iface string, tableID int, gatewayIP, sourceIP string) error {
	if runtime.GOOS != "linux" {
		// Non-Linux platforms do not have iproute2 policy routing
		return nil
	}

	if _, err := exec.LookPath("ip"); err != nil {
		return nil
	}

	tableStr := strconv.Itoa(tableID)

	// 1. Add default route for table
	if gatewayIP != "" && iface != "" {
		err := r.execCommand("ip", "route", "replace", "default", "via", gatewayIP, "dev", iface, "table", tableStr)
		if err != nil {
			return fmt.Errorf("ip route replace error: %w", err)
		}
	}

	// 2. Add rule for source IP if specified
	if sourceIP != "" {
		// Try adding rule (suppressing duplicate rule error)
		_ = r.execCommand("ip", "rule", "add", "from", sourceIP, "table", tableStr)
	}

	return nil
}
