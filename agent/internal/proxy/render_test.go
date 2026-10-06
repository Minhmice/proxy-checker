package proxy_test

import (
	"strings"
	"testing"

	"proxyfleet/agent/internal/controller"
	"proxyfleet/agent/internal/proxy"
)

func TestRenderConfigValidatesAndFormats3Proxy(t *testing.T) {
	endpoints := []controller.ProxyEndpointConfig{
		{
			ID:         "ep-http-1",
			Protocol:   "http",
			ListenIP:   "10.77.0.11",
			ListenPort: 20001,
			Username:   "testuser",
			Password:   "testpass",
			Enabled:    true,
		},
		{
			ID:         "ep-socks-1",
			Protocol:   "socks5",
			ListenIP:   "10.77.0.11",
			ListenPort: 30001,
			Username:   "socksuser",
			Password:   "sockspass",
			Enabled:    true,
		},
	}

	cfg, digest, err := proxy.RenderConfig(endpoints)
	if err != nil {
		t.Fatalf("RenderConfig failed: %v", err)
	}

	if digest == "" {
		t.Errorf("Expected non-empty digest")
	}

	if !strings.Contains(cfg, "users testuser:CL:testpass") {
		t.Errorf("Expected testuser authentication line, got: %s", cfg)
	}

	if !strings.Contains(cfg, "proxy -p20001 -i10.77.0.11") {
		t.Errorf("Expected http proxy directive, got: %s", cfg)
	}

	if !strings.Contains(cfg, "socks -p30001 -i10.77.0.11") {
		t.Errorf("Expected socks proxy directive, got: %s", cfg)
	}

	// CRLF injection attempt must fail
	malicious := []controller.ProxyEndpointConfig{
		{
			ID:         "ep-bad",
			Protocol:   "http",
			ListenIP:   "10.77.0.11\nmalicious directive",
			ListenPort: 20002,
			Username:   "user",
			Password:   "pass",
			Enabled:    true,
		},
	}
	_, _, err = proxy.RenderConfig(malicious)
	if err == nil {
		t.Errorf("Expected CRLF injection error, got nil")
	}
}
