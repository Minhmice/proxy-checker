package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"proxyfleet/agent/internal/config"
	"proxyfleet/agent/internal/controller"
	"proxyfleet/agent/internal/health"
	"proxyfleet/agent/internal/proxy"
)

func generateWireGuardKeypair() (string, string, error) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	pub := base64.StdEncoding.EncodeToString(priv.PublicKey().Bytes())
	privStr := base64.StdEncoding.EncodeToString(priv.Bytes())
	return pub, privStr, nil
}

const Version = "0.1.0"

func main() {
	serverURL := flag.String("server", "", "Controller server base URL")
	enrollToken := flag.String("token", "", "One-time enrollment token")
	nodeName := flag.String("node-name", "", "Node name (defaults to system hostname)")
	configDir := flag.String("config-dir", "/etc/proxyfleet", "Path to agent configuration directory")
	proxyConfigPath := flag.String("proxy-config", "/etc/3proxy/3proxy.cfg", "Path to 3proxy configuration file")
	intervalSec := flag.Int("interval", 15, "Heartbeat and polling interval in seconds")
	showVersion := flag.Bool("version", false, "Print agent version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("proxyfleet-agent v%s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		os.Exit(0)
	}

	if runtime.GOOS == "windows" && *configDir == "/etc/proxyfleet" {
		*configDir = "./data/agent"
		*proxyConfigPath = "./data/agent/3proxy.cfg"
	}

	cfgMgr := config.NewManager(*configDir)
	state, err := cfgMgr.Load()
	if err != nil {
		log.Fatalf("[agent] Error loading state: %v", err)
	}

	if *serverURL != "" {
		state.ServerURL = *serverURL
	}
	if state.ServerURL == "" {
		log.Fatalf("[agent] Server URL is required (--server)")
	}

	if *nodeName == "" {
		if host, err := os.Hostname(); err == nil {
			*nodeName = host
		} else {
			*nodeName = "worker-node"
		}
	}

	client := controller.NewClient(state.ServerURL, 10*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 1. Enrollment phase if not yet enrolled
	if state.NodeID == "" {
		if *enrollToken == "" {
			log.Fatalf("[agent] Node is not enrolled. Provide --token to enroll with controller.")
		}
		if state.WireGuardPublicKey == "" {
			pub, priv, err := generateWireGuardKeypair()
			if err != nil {
				log.Fatalf("[agent] Failed to generate WireGuard keypair: %v", err)
			}
			state.WireGuardPublicKey = pub
			state.WireGuardPrivateKey = priv
		}
		log.Printf("[agent] Enrolling node '%s' with controller %s...", *nodeName, state.ServerURL)
		enrollResp, err := client.Enroll(ctx, controller.EnrollRequest{
			Token:              *enrollToken,
			NodeName:           *nodeName,
			WireguardPublicKey: state.WireGuardPublicKey,
			OS:                 runtime.GOOS,
			Arch:               runtime.GOARCH,
			AgentVersion:       Version,
		})
		if err != nil {
			log.Fatalf("[agent] Enrollment failed: %v", err)
		}

		state.NodeID = enrollResp.NodeID
		state.NodeName = enrollResp.NodeName
		state.WireGuardIP = enrollResp.WireGuardIP
		if err := cfgMgr.Save(state); err != nil {
			log.Fatalf("[agent] Failed to save state after enrollment: %v", err)
		}
		log.Printf("[agent] Successfully enrolled as node ID: %s, WireGuard IP: %s", state.NodeID, state.WireGuardIP)
	}

	log.Printf("[agent] Running ProxyFleet Agent v%s (Node: %s, WG IP: %s)", Version, state.NodeID, state.WireGuardIP)

	deployer := proxy.NewDeployer(*proxyConfigPath)
	checker := health.NewChecker(5 * time.Second)

	// Listen for shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	ticker := time.NewTicker(time.Duration(*intervalSec) * time.Second)
	defer ticker.Stop()

	// Immediate first run
	runCycle(ctx, client, state, cfgMgr, deployer, checker)

	for {
		select {
		case <-sigChan:
			log.Println("[agent] Shutting down gracefully...")
			return
		case <-ticker.C:
			runCycle(ctx, client, state, cfgMgr, deployer, checker)
		}
	}
}

func runCycle(
	ctx context.Context,
	client *controller.Client,
	state *config.State,
	cfgMgr *config.Manager,
	deployer *proxy.Deployer,
	checker *health.Checker,
) {
	// 1. Send heartbeat
	err := client.SendHeartbeat(ctx, controller.HeartbeatRequest{
		NodeID:       state.NodeID,
		Status:       "online",
		AgentVersion: Version,
	})
	if err != nil {
		log.Printf("[agent] Heartbeat warning: %v", err)
	}

	// 2. Poll desired state
	desired, err := client.GetDesiredState(ctx, state.NodeID)
	if err != nil {
		log.Printf("[agent] Desired state poll error: %v", err)
		return
	}

	if desired.Revision <= state.LastRevision {
		return
	}

	log.Printf("[agent] New configuration revision received: %d (%d proxies)", desired.Revision, len(desired.Proxies))

	renderedConfig, digest, err := proxy.RenderConfig(desired.Proxies)
	if err != nil {
		log.Printf("[agent] Failed to render 3proxy config: %v", err)
		_ = client.ReportDeploymentResult(ctx, controller.DeploymentResultRequest{
			NodeID:       state.NodeID,
			Revision:     desired.Revision,
			ConfigDigest: digest,
			Status:       "failed",
			ErrorMessage: err.Error(),
		})
		return
	}

	// Apply configuration
	if err := deployer.Apply(renderedConfig); err != nil {
		log.Printf("[agent] Deployment failed, rolled back: %v", err)
		_ = client.ReportDeploymentResult(ctx, controller.DeploymentResultRequest{
			NodeID:       state.NodeID,
			Revision:     desired.Revision,
			ConfigDigest: digest,
			Status:       "failed",
			ErrorMessage: err.Error(),
		})
		return
	}

	// Health check deployed ports
	for _, p := range desired.Proxies {
		if !p.Enabled {
			continue
		}
		if err := checker.CheckPort(ctx, p.ListenIP, p.ListenPort); err != nil {
			log.Printf("[agent] Warning: listener %s:%d not responding: %v", p.ListenIP, p.ListenPort, err)
		}
	}

	state.LastRevision = desired.Revision
	_ = cfgMgr.Save(state)

	_ = client.ReportDeploymentResult(ctx, controller.DeploymentResultRequest{
		NodeID:       state.NodeID,
		Revision:     desired.Revision,
		ConfigDigest: digest,
		Status:       "applied",
	})
	log.Printf("[agent] Successfully applied revision %d", desired.Revision)
}
