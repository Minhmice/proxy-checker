package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"proxyfleet/agent/internal/config"
	"proxyfleet/agent/internal/controller"
	"proxyfleet/agent/internal/device"
	"proxyfleet/agent/internal/health"
	"proxyfleet/agent/internal/proxy"
	"proxyfleet/agent/internal/telemetry"
	"proxyfleet/agent/internal/wireguard"
)

const Version = "0.2.0"

func generateWireGuardKeypair() (string, string, error) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	pub := base64.StdEncoding.EncodeToString(priv.PublicKey().Bytes())
	privStr := base64.StdEncoding.EncodeToString(priv.Bytes())
	return pub, privStr, nil
}

func generateSessionID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("sess_%016d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func sanitizeStringMap(m map[string]string) map[string]string {
	if m == nil {
		return nil
	}
	res := make(map[string]string, len(m))
	count := 0
	for k, v := range m {
		if count >= 32 {
			break
		}
		if len(v) > 256 {
			v = v[:256]
		}
		res[k] = v
		count++
	}
	return res
}

func sanitizeErrorString(err error, secrets ...string) *string {
	if err == nil {
		return nil
	}
	s := err.Error()
	for _, sec := range secrets {
		if sec != "" && len(sec) >= 4 {
			s = strings.ReplaceAll(s, sec, "[REDACTED]")
		}
	}
	if len(s) > 256 {
		s = s[:256]
	}
	return &s
}

func setupStateAndAuth(state *config.State, cfgMgr *config.Manager, client *controller.Client, agentTokenFlag string) error {
	if agentTokenFlag != "" {
		state.AgentToken = agentTokenFlag
		if state.NodeID != "" {
			if err := cfgMgr.Save(state); err != nil {
				return fmt.Errorf("failed to save state with agent token: %w", err)
			}
			log.Printf("[agent] Provisioned agent token for existing node %s", state.NodeID)
		}
	}

	if state.NodeID != "" {
		if strings.TrimSpace(state.AgentToken) == "" {
			return fmt.Errorf("node %s is enrolled but missing agent token: generate token via POST /api/fleet/nodes/%s/agent-token and pass via --agent-token", state.NodeID, state.NodeID)
		}
		client.SetAgentToken(state.AgentToken)
	}
	return nil
}

type AgentRuntime struct {
	client             *controller.Client
	state              *config.State
	cfgMgr             *config.Manager
	deployer           *proxy.Deployer
	checker            *health.Checker
	wgMgr              *wireguard.Manager
	telemetryCollector *telemetry.Collector
	deviceInfo         device.Info
	sessionID          string
	sessionRegistered  atomic.Bool
	sequence           atomic.Uint64
	startTime          time.Time
 stateMu            sync.Mutex
 reportMu           sync.Mutex
 applyMu            sync.Mutex
	activityMu         sync.RWMutex
	activity           controller.FleetRuntimeActivity
	activeProxiesMu    sync.RWMutex
	activeProxies      []controller.ProxyEndpointConfig
	listenerErrorsMu   sync.RWMutex
	listenerErrors     map[int]string
}

func NewAgentRuntime(
	client *controller.Client,
	state *config.State,
	cfgMgr *config.Manager,
	deployer *proxy.Deployer,
	checker *health.Checker,
	wgMgr *wireguard.Manager,
	telemetryCollector *telemetry.Collector,
	deviceInfo device.Info,
	sessionID string,
) *AgentRuntime {
	rt := &AgentRuntime{
		client:             client,
		state:              state,
		cfgMgr:             cfgMgr,
		deployer:           deployer,
		checker:            checker,
		wgMgr:              wgMgr,
		telemetryCollector: telemetryCollector,
		deviceInfo:         deviceInfo,
		sessionID:          sessionID,
		startTime:          time.Now(),
		listenerErrors:     make(map[int]string),
		activity: controller.FleetRuntimeActivity{
			Kind:      "idle",
			StartedAt: time.Now().UnixMilli(),
		},
	}
	return rt
}

func (r *AgentRuntime) recordListenerError(port int, err error) {
	r.listenerErrorsMu.Lock()
	defer r.listenerErrorsMu.Unlock()
	if err != nil {
		r.listenerErrors[port] = err.Error()
	} else {
		delete(r.listenerErrors, port)
	}
}

func (r *AgentRuntime) SetActivity(kind string, revision *int64, err *string) {
	r.activityMu.Lock()
	defer r.activityMu.Unlock()

	// Preserve startedAt if state kind, revision, and error are identical
	if r.activity.Kind == kind &&
		((r.activity.Revision == nil && revision == nil) || (r.activity.Revision != nil && revision != nil && *r.activity.Revision == *revision)) &&
		((r.activity.Error == nil && err == nil) || (r.activity.Error != nil && err != nil && *r.activity.Error == *err)) {
		return
	}

	r.activity = controller.FleetRuntimeActivity{
		Kind:      kind,
		StartedAt: time.Now().UnixMilli(),
		Revision:  revision,
		Error:     err,
	}
}

func (r *AgentRuntime) GetActivity() controller.FleetRuntimeActivity {
	r.activityMu.RLock()
	defer r.activityMu.RUnlock()
	return r.activity
}

func (r *AgentRuntime) SetActiveProxies(proxies []controller.ProxyEndpointConfig) {
	r.activeProxiesMu.Lock()
	defer r.activeProxiesMu.Unlock()
	r.activeProxies = append([]controller.ProxyEndpointConfig(nil), proxies...)
}

func (r *AgentRuntime) GetActiveProxies() []controller.ProxyEndpointConfig {
	r.activeProxiesMu.RLock()
	defer r.activeProxiesMu.RUnlock()
	return append([]controller.ProxyEndpointConfig(nil), r.activeProxies...)
}

func (r *AgentRuntime) stateSnapshot() config.State {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	state := *r.state
	if r.state.WireGuard != nil {
		wg := *r.state.WireGuard
		wg.AllowedIPs = append([]string(nil), wg.AllowedIPs...)
		state.WireGuard = &wg
	}
	if r.state.PendingReport != nil {
		report := *r.state.PendingReport
		state.PendingReport = &report
	}
	return state
}

func (r *AgentRuntime) saveStateLocked() error {
	return r.cfgMgr.Save(r.state)
}

func (r *AgentRuntime) retryPendingReport(ctx context.Context) {
 r.reportMu.Lock()
 defer r.reportMu.Unlock()
	snapshot := r.stateSnapshot()
	if snapshot.PendingReport == nil {
		return
	}
	pending := *snapshot.PendingReport
	if err := r.client.ReportDeploymentResult(ctx, pending); err != nil {
		log.Printf("[agent] Failed to report pending deployment result (will retry): %v", err)
		return
	}
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	if r.state.PendingReport == nil || *r.state.PendingReport != pending {
		return
	}
	r.state.PendingReport = nil
	if err := r.saveStateLocked(); err != nil {
		log.Printf("[agent] Failed to save state after clearing pending report: %v", err)
		r.state.PendingReport = &pending
	}
}

func (r *AgentRuntime) updateWireGuard(desired *wireguard.Desired) error {
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	previous := r.state.WireGuard
	r.state.WireGuard = desired
	if err := r.saveStateLocked(); err != nil {
		r.state.WireGuard = previous
		return err
	}
	return nil
}

func (r *AgentRuntime) SendHeartbeat(ctx context.Context) error {
	state := r.stateSnapshot()
	if !r.sessionRegistered.Load() {
		if _, err := r.client.RegisterRuntimeSession(ctx, controller.RuntimeSessionRequest{NodeID: state.NodeID, SessionID: r.sessionID}); err == nil {
			r.sessionRegistered.Store(true)
		} else {
			log.Printf("[agent] Session registration retry warning: %v", err)
			return r.client.SendHeartbeat(ctx, controller.HeartbeatRequest{NodeID: state.NodeID, Status: "online", AgentVersion: Version})
		}
	}
	seq := r.sequence.Add(1)
	active := r.GetActiveProxies()
	var managedPorts []int
	for _, p := range active {
		if p.Enabled && p.ListenPort > 0 {
			managedPorts = append(managedPorts, p.ListenPort)
		}
	}
	tSnap := r.telemetryCollector.Sample(ctx, managedPorts)
	var obs wireguard.Observation
	if r.GetActivity().Kind == "applying" {
		obs.State = "unknown"
		message := "wireguard observation deferred during apply"
		obs.Error = &message
	} else {
		obs = r.wgMgr.Observe(ctx)
	}
	if state.WireGuard == nil && obs.State == "healthy" {
		obs.State = "unknown"
		obs.ProbeOk = nil
		errStr := "wireguard configuration unavailable"
		obs.Error = &errStr
	}
	act := r.GetActivity()
	uptime := uint64(time.Since(r.startTime).Seconds())
	dev := r.deviceInfo
	dev.Sources = sanitizeStringMap(dev.Sources)
	unavailable := sanitizeStringMap(tSnap.Unavailable)
	r.listenerErrorsMu.RLock()
	var firstListenerErr string
	failedListeners := len(r.listenerErrors)
	for _, e := range r.listenerErrors {
		firstListenerErr = e
		break
	}
	r.listenerErrorsMu.RUnlock()
	if failedListeners > 0 {
		if tSnap.Proxy.State == "running" {
			tSnap.Proxy.State = "stopped"
		}
		if tSnap.Proxy.Error == nil {
			tSnap.Proxy.Error = &firstListenerErr
		}
	}
	snapshot := controller.FleetRuntimeSnapshot{SchemaVersion: 1, SessionID: r.sessionID, Sequence: seq, SampledAt: tSnap.SampledAt, UptimeSeconds: &uptime, Activity: act, CPUPercent: tSnap.CPUPercent, LoadAverage1m: tSnap.LoadAverage1m, MemoryAvailableBytes: tSnap.MemoryAvailableBytes, MemoryTotalBytes: tSnap.MemoryTotalBytes, Network: tSnap.Network, Proxy: tSnap.Proxy, Overlay: obs, Unavailable: unavailable}
	status := "online"
	if obs.State != "healthy" || tSnap.Proxy.State == "stopped" || failedListeners > 0 || act.Kind == "error" {
		status = "degraded"
	}
	req := controller.HeartbeatRequest{NodeID: state.NodeID, Status: status, AgentVersion: Version, Device: &dev, Runtime: &snapshot}
	if tSnap.CPUPercent != nil {
		req.CPUUsage = *tSnap.CPUPercent
	}
	return r.client.SendHeartbeat(ctx, req)
}

func (r *AgentRuntime) ApplyDesired(ctx context.Context, desired *controller.DesiredStateResponse) {
	r.applyMu.Lock()
	defer r.applyMu.Unlock()
	if desired == nil {
		return
	}
	if ctx.Err() != nil {
		return
	}
	state := r.stateSnapshot()
	if state.PendingReport != nil || desired.Revision <= state.LastRevision {
		return
	}
	r.SetActivity("applying", &desired.Revision, nil)
	if desired.WireGuard != nil {
		if err := r.wgMgr.Reconcile(ctx, *desired.WireGuard, state.WireGuardPrivateKey); err != nil {
			sanitized := sanitizeErrorString(err, state.WireGuardPrivateKey, state.AgentToken)
			r.SetActivity("error", &desired.Revision, sanitized)
			r.submitReport(ctx, controller.DeploymentResultRequest{NodeID: state.NodeID, Revision: desired.Revision, ConfigDigest: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%d", desired.Revision)))), Status: "failed", ErrorMessage: *sanitized})
			return
		}
		if err := r.updateWireGuard(desired.WireGuard); err != nil {
			log.Printf("[agent] Failed to save state with wireguard config: %v", err)
			return
		}
		state = r.stateSnapshot()
	}
	if desired.Revision <= state.LastRevision {
		return
	}
	log.Printf("[agent] New configuration revision received: %d (%d proxies)", desired.Revision, len(desired.Proxies))
	r.SetActivity("applying", &desired.Revision, nil)
	renderedConfig, digest, renderErr := proxy.RenderConfig(desired.Proxies, desired.Capacity)
	if renderErr != nil {
		sanitized := sanitizeErrorString(renderErr, state.WireGuardPrivateKey, state.AgentToken)
		r.SetActivity("error", &desired.Revision, sanitized)
		r.submitReport(ctx, controller.DeploymentResultRequest{NodeID: state.NodeID, Revision: desired.Revision, ConfigDigest: fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%d", desired.Revision)))), Status: "failed", ErrorMessage: *sanitized})
		return
	}
	if desired.WireGuard == nil && hasOverlayProxy(desired.Proxies) && os.Getenv("PROXYFLEET_MOCK_RELOAD") != "1" {
		errMsg := "desired proxies require WireGuard overlay but desired wireguard configuration is missing"
		if desired.WireGuardError != nil && *desired.WireGuardError != "" {
			errMsg = fmt.Sprintf("desired proxies require WireGuard overlay but wireguard setup unavailable: %s", *desired.WireGuardError)
		}
		r.SetActivity("error", &desired.Revision, &errMsg)
		r.submitReport(ctx, controller.DeploymentResultRequest{NodeID: state.NodeID, Revision: desired.Revision, ConfigDigest: digest, Status: "failed", ErrorMessage: errMsg})
		return
	}
	if err := r.deployer.Apply(renderedConfig); err != nil {
		sanitized := sanitizeErrorString(err, state.WireGuardPrivateKey, state.AgentToken)
		log.Printf("[agent] Deployment failed, rolled back: %v", err)
		r.SetActivity("error", &desired.Revision, sanitized)
		r.submitReport(ctx, controller.DeploymentResultRequest{NodeID: state.NodeID, Revision: desired.Revision, ConfigDigest: digest, Status: "failed", ErrorMessage: *sanitized})
		return
	}
	if os.Getenv("PROXYFLEET_MOCK_RELOAD") != "1" {
		for _, p := range desired.Proxies {
			if p.Enabled {
				if err := r.checker.CheckPort(ctx, p.ListenIP, p.ListenPort); err != nil {
					log.Printf("[agent] Warning: listener %s:%d not responding: %v", p.ListenIP, p.ListenPort, err)
				}
			}
		}
	}
	r.stateMu.Lock()
	previousRevision := r.state.LastRevision
	r.state.LastRevision = desired.Revision
	if err := r.saveStateLocked(); err != nil {
		r.state.LastRevision = previousRevision
		r.stateMu.Unlock()
		log.Printf("[agent] Failed to persist applied revision %d: %v", desired.Revision, err)
		return
	}
	r.stateMu.Unlock()
	r.SetActiveProxies(desired.Proxies)
	r.SetActivity("idle", nil, nil)
	r.submitReport(ctx, controller.DeploymentResultRequest{NodeID: state.NodeID, Revision: desired.Revision, ConfigDigest: digest, Status: "applied"})
	log.Printf("[agent] Successfully applied revision %d", desired.Revision)
}

func hasOverlayProxy(proxies []controller.ProxyEndpointConfig) bool {
	for _, p := range proxies {
		if strings.HasPrefix(p.ListenIP, "10.77.") {
			return true
		}
	}
	return false
}

func (r *AgentRuntime) submitReport(ctx context.Context, report controller.DeploymentResultRequest) {
	r.reportMu.Lock()
	defer r.reportMu.Unlock()
	r.stateMu.Lock()
	previous := r.state.PendingReport
	r.state.PendingReport = &report
	if err := r.saveStateLocked(); err != nil {
		r.state.PendingReport = previous
		r.stateMu.Unlock()
		log.Printf("[agent] Failed to save state with pending report: %v (stopping send)", err)
		return
	}
	r.stateMu.Unlock()
	if err := r.client.ReportDeploymentResult(ctx, report); err != nil {
		log.Printf("[agent] Failed to report deployment result (will retry): %v", err)
		return
	}
	r.stateMu.Lock()
	defer r.stateMu.Unlock()
	if r.state.PendingReport == nil || *r.state.PendingReport != report {
		return
	}
	r.state.PendingReport = nil
	if err := r.saveStateLocked(); err != nil {
		log.Printf("[agent] Failed to save state after clearing pending report: %v (preserving report)", err)
		r.state.PendingReport = &report
	}
}

func (r *AgentRuntime) RecordWireGuardCycle(ctx context.Context) {
	if r.GetActivity().Kind == "applying" {
		return
	}
	if !r.applyMu.TryLock() {
		return
	}
	defer r.applyMu.Unlock()
	obs := r.wgMgr.Observe(ctx)
	if obs.ProbeOk == nil {
		return
	}
	if err := r.wgMgr.RecordCycleResult(*obs.ProbeOk); err != nil {
		log.Printf("[agent] Failed to persist WireGuard cycle result: %v", err)
		return
	}
	state := r.stateSnapshot()
	if *obs.ProbeOk || state.WireGuard == nil || r.GetActivity().Kind == "applying" {
		return
	}
	if err := r.wgMgr.Recover(ctx); err != nil {
		log.Printf("[agent] WireGuard recovery not completed: %v", err)
	}
}

func (r *AgentRuntime) RunCycle(ctx context.Context) {
	r.retryPendingReport(ctx)
	r.RecordWireGuardCycle(ctx)
	if err := r.SendHeartbeat(ctx); err != nil {
		log.Printf("[agent] Heartbeat warning: %v", err)
	}
	state := r.stateSnapshot()
	desired, err := r.client.GetDesiredState(ctx, state.NodeID)
	if err != nil {
		log.Printf("[agent] Desired state poll error: %v", err)
		return
	}
	r.SetActiveProxies(desired.Proxies)
	for _, p := range desired.Proxies {
		if p.Enabled {
			r.recordListenerError(p.ListenPort, r.checker.CheckPort(ctx, p.ListenIP, p.ListenPort))
		}
	}
	if desired.Revision > state.LastRevision {
		r.ApplyDesired(ctx, desired)
		return
	}
	if desired.WireGuard != nil {
		r.applyMu.Lock()
		defer r.applyMu.Unlock()
		state = r.stateSnapshot()
		if desired.Revision > state.LastRevision {
			return
		}
		if err := r.wgMgr.Reconcile(ctx, *desired.WireGuard, state.WireGuardPrivateKey); err != nil {
			log.Printf("[agent] WireGuard reconciliation failed: %v", err)
			return
		}
		if err := r.updateWireGuard(desired.WireGuard); err != nil {
			log.Printf("[agent] Failed to persist WireGuard state: %v", err)
		}
	}
}



var (
	globalRuntimeMu sync.Mutex
	globalRuntime   *AgentRuntime
)

func getOrCreateRuntime(
	client *controller.Client,
	state *config.State,
	cfgMgr *config.Manager,
	deployer *proxy.Deployer,
	checker *health.Checker,
) *AgentRuntime {
	globalRuntimeMu.Lock()
	defer globalRuntimeMu.Unlock()

	if globalRuntime != nil && globalRuntime.state == state {
		return globalRuntime
	}

	configDir := filepath.Dir(cfgMgr.StateFilePath())
	wgMgr := wireguard.NewManager(configDir)
	telemetryCollector := telemetry.NewCollector()
	deviceInfo := device.Detect()
	sessionID := generateSessionID()

	globalRuntime = NewAgentRuntime(
		client,
		state,
		cfgMgr,
		deployer,
		checker,
		wgMgr,
		telemetryCollector,
		deviceInfo,
		sessionID,
	)
	return globalRuntime
}

func runCycle(
	ctx context.Context,
	client *controller.Client,
	state *config.State,
	cfgMgr *config.Manager,
	deployer *proxy.Deployer,
	checker *health.Checker,
) {
	rt := getOrCreateRuntime(client, state, cfgMgr, deployer, checker)
	rt.RunCycle(ctx)
}

func main() {
	serverURL := flag.String("server", "", "Controller server base URL")
	enrollToken := flag.String("token", "", "One-time enrollment token")
	agentToken := flag.String("agent-token", "", "Agent bearer token for node authentication")
	nodeName := flag.String("node-name", "", "Node name (defaults to system hostname)")
	configDir := flag.String("config-dir", "/etc/proxyfleet", "Path to agent configuration directory")
	proxyConfigPath := flag.String("proxy-config", "/etc/3proxy/3proxy.cfg", "Path to 3proxy configuration file")
	intervalSec := flag.Int("interval", 15, "Heartbeat and polling interval in seconds")
	showVersion := flag.Bool("version", false, "Print agent version and exit")
	diagnostics := flag.Bool("diagnostics", false, "Print host device and telemetry diagnostics as JSON and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("proxyfleet-agent v%s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		os.Exit(0)
	}

	if *diagnostics {
		dev := device.Detect()
		col := telemetry.NewCollector()
		sample1 := col.Sample(context.Background(), nil)
		time.Sleep(1 * time.Second)
		sample2 := col.Sample(context.Background(), nil)

		type DiagOutput struct {
			Device  device.Info          `json:"device"`
			Samples []telemetry.Snapshot `json:"samples"`
		}
		out := DiagOutput{
			Device:  dev,
			Samples: []telemetry.Snapshot{sample1, sample2},
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(out); err != nil {
			log.Fatalf("failed to encode diagnostics: %v", err)
		}
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

	if err := setupStateAndAuth(state, cfgMgr, client, *agentToken); err != nil {
		log.Fatalf("[agent] %v", err)
	}

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
		if strings.TrimSpace(enrollResp.AgentToken) == "" {
			log.Fatalf("[agent] Enrollment rejected: controller response missing agent token")
		}

		state.NodeID = enrollResp.NodeID
		state.NodeName = enrollResp.NodeName
		state.WireGuardIP = enrollResp.WireGuardIP
		state.ServerWireGuardPublicKey = enrollResp.ServerWireguardPublicKey
		state.ServerWireGuardEndpoint = enrollResp.ServerWireguardEndpoint
		state.AgentToken = enrollResp.AgentToken
		state.AgentVersion = Version
		if err := cfgMgr.Save(state); err != nil {
			log.Fatalf("[agent] Failed to save state after enrollment: %v", err)
		}
		client.SetAgentToken(state.AgentToken)
		log.Printf("[agent] Successfully enrolled as node ID: %s, WireGuard IP: %s", state.NodeID, state.WireGuardIP)
	}

	log.Printf("[agent] Running ProxyFleet Agent v%s (Node: %s, WG IP: %s)", Version, state.NodeID, state.WireGuardIP)

	// Register runtime session with controller
	sessionID := generateSessionID()
	log.Printf("[agent] Registering runtime session %s for node %s...", sessionID, state.NodeID)
	if _, err := client.RegisterRuntimeSession(ctx, controller.RuntimeSessionRequest{
		NodeID:    state.NodeID,
		SessionID: sessionID,
	}); err != nil {
		log.Printf("[agent] Warning: failed to register runtime session: %v", err)
	}

	deployer := proxy.NewDeployer(*proxyConfigPath)
	checker := health.NewChecker(5 * time.Second)
	wgMgr := wireguard.NewManager(*configDir)
	telemetryCollector := telemetry.NewCollector()
	deviceInfo := device.Detect()

	rt := NewAgentRuntime(
		client,
		state,
		cfgMgr,
		deployer,
		checker,
		wgMgr,
		telemetryCollector,
		deviceInfo,
		sessionID,
	)

	// Listen for shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	interval := time.Duration(*intervalSec) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	applyQueue := make(chan *controller.DesiredStateResponse, 1)
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		for {
			select {
			case <-ctx.Done():
				return
			case desired := <-applyQueue:
				if ctx.Err() == nil && desired != nil {
					rt.ApplyDesired(ctx, desired)
				}
			}
		}
	}()

	runTick := func() {
		if err := rt.SendHeartbeat(ctx); err != nil {
			log.Printf("[agent] Heartbeat warning: %v", err)
		}
		rt.RecordWireGuardCycle(ctx)
		rt.retryPendingReport(ctx)
		state := rt.stateSnapshot()
		desired, err := rt.client.GetDesiredState(ctx, state.NodeID)
		if err != nil || desired == nil {
			return
		}
		if desired.Revision > state.LastRevision {
			select {
			case applyQueue <- desired:
			default:
				select {
				case <-applyQueue:
				default:
				}
				select {
				case applyQueue <- desired:
				case <-ctx.Done():
				}
			}
			return
		}
		rt.SetActiveProxies(desired.Proxies)
		for _, p := range desired.Proxies {
			if p.Enabled {
				rt.recordListenerError(p.ListenPort, rt.checker.CheckPort(ctx, p.ListenIP, p.ListenPort))
			}
		}
		if desired.WireGuard != nil {
			rt.applyMu.Lock()
			defer rt.applyMu.Unlock()
			if desired.Revision > state.LastRevision {
				return
			}
			state = rt.stateSnapshot()
			if err := rt.wgMgr.Reconcile(ctx, *desired.WireGuard, state.WireGuardPrivateKey); err != nil {
				log.Printf("[agent] WireGuard reconciliation failed: %v", err)
				return
			}
			if err := rt.updateWireGuard(desired.WireGuard); err != nil {
				log.Printf("[agent] Failed to persist WireGuard state: %v", err)
			}
		}
	}

	runTick()

	for {
		select {
		case <-sigChan:
			log.Println("[agent] Shutting down gracefully...")
			cancel()
			<-workerDone
			return
		case <-ctx.Done():
			<-workerDone
			return
		case <-ticker.C:
			runTick()
		}
	}
}
