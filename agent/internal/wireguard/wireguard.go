package wireguard

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrInvalidPrivateKey     = errors.New("invalid wireguard private key: must be valid 32-byte base64 string")
	ErrInvalidPublicKey      = errors.New("invalid wireguard public key: must be valid 32-byte base64 string")
	ErrInvalidAddressCIDR    = errors.New("invalid address CIDR")
	ErrInvalidEndpoint       = errors.New("invalid controller endpoint: must be host:port")
	ErrInvalidAllowedIPs     = errors.New("invalid allowed IPs")
	ErrInvalidMTU            = errors.New("invalid MTU: must be between 1280 and 9000")
	ErrInvalidInterfaceName  = errors.New("invalid interface name: must strictly match 'proxyfleet'")
	ErrSubnetMismatch        = errors.New("address or allowed IPs outside 10.77.0.0/24 overlay subnet")
	ErrDefaultRouteForbidden = errors.New("default routes (0.0.0.0/0 or ::/0) forbidden on worker overlay")
	ErrForeignOwnership      = errors.New("interface or configuration is foreign; refusing to adopt or delete")
	ErrRecoveryCooldown      = errors.New("recovery cooldown active: minimum 5 minutes between recovery attempts")
	ErrThresholdNotMet       = errors.New("recovery threshold not reached: requires 3 consecutive probe failures")
	ErrMissingDesiredState   = errors.New("no desired state loaded or persisted")
	ErrStatePersistFailed    = errors.New("failed to persist recovery or desired state; failing closed")
	ErrUnsupportedPlatform   = errors.New("wireguard is not supported on this platform")
)

const (
	DefaultInterfaceName       = "proxyfleet"
	DefaultKeepaliveSeconds    = 25
	DefaultControllerOverlayIP = "10.77.0.1"
	FleetOverlayCIDR           = "10.77.0.0/24"
	MinMTU                     = 1280
	MaxMTU                     = 9000
	RequiredFailureCycles      = 3
	RecoveryCooldownDuration   = 5 * time.Minute
	RecoveryStateFilename      = "recovery_state.json"
	DesiredStateFilename       = "desired_state.json"
	OwnershipMarkerFilename    = "proxyfleet.owner"
	ConfigFileExt              = ".conf"
	OwnedHeaderPrefix          = "# ProxyFleet Owned WireGuard Configuration"
	MaxDiagnosticLength        = 256
)

type Desired struct {
	InterfaceName              string   `json:"interfaceName"`
	AddressCIDR                string   `json:"addressCidr"`
	ControllerPublicKey        string   `json:"controllerPublicKey"`
	ControllerEndpoint         string   `json:"controllerEndpoint"`
	AllowedIPs                 []string `json:"allowedIps"`
	PersistentKeepaliveSeconds int      `json:"persistentKeepaliveSeconds"`
	MTU                        *int     `json:"mtu"`
}

type Observation struct {
	State            string  `json:"state"` // "healthy" | "unhealthy" | "unknown"
	InterfacePresent *bool   `json:"interfacePresent"`
	PeerPresent      *bool   `json:"peerPresent"`
	LastHandshakeAt  *int64  `json:"lastHandshakeAt"` // Unix ms
	ProbeOk          *bool   `json:"probeOk"`
	RxBytes          *int64  `json:"rxBytes"`
	TxBytes          *int64  `json:"txBytes"`
	Error            *string `json:"error"`
	LastRecoveryAt   *int64  `json:"lastRecoveryAt"` // Unix ms
}

type PersistedRecoveryState struct {
	ConsecutiveFailures int   `json:"consecutiveFailures"`
	LastRecoveryAt      int64 `json:"lastRecoveryAt"` // Unix ms
}

type OwnershipMarker struct {
	InterfaceName       string `json:"interfaceName"`
	ControllerPublicKey string `json:"controllerPublicKey"`
	AddressCIDR         string `json:"addressCidr"`
	CreatedAt           int64  `json:"createdAt"`
}

type commandRunner interface {
	Run(ctx context.Context, name string, args ...string) (stdout string, err error)
}

type prober interface {
	Probe(ctx context.Context, target string) error
}

type platformBackend interface {
	DetectTools() error
	ConfigureInterface(ctx context.Context, confPath string, desired Desired) error
	RemoveInterface(ctx context.Context, ifaceName string) error
	ReadDump(ctx context.Context, ifaceName string) (string, error)
	RestartInterface(ctx context.Context, confPath string, desired Desired) error
}

type Manager struct {
	mu            sync.Mutex
	configDir     string
	backend       platformBackend
	runner        commandRunner
	prober        prober
	latestDesired *Desired
}

func NewManager(configDir string) *Manager {
	m := &Manager{
		configDir: configDir,
	}
	m.initPlatformBackend()
	if m.prober == nil {
		m.prober = &defaultProber{}
	}
	_ = m.loadPersistedDesired()
	return m
}

func ValidateKey(key string) error {
	trimmed := strings.TrimSpace(key)
	if len(trimmed) == 0 {
		return errors.New("key is empty")
	}
	raw, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil {
		return fmt.Errorf("base64 decode error: %w", err)
	}
	if len(raw) != 32 {
		return fmt.Errorf("key byte length must be 32, got %d", len(raw))
	}
	return nil
}

func ValidateDesired(desired Desired, privateKey string) error {
	if desired.InterfaceName != DefaultInterfaceName {
		return ErrInvalidInterfaceName
	}
	if err := ValidateKey(privateKey); err != nil {
		return ErrInvalidPrivateKey
	}
	if err := ValidateKey(desired.ControllerPublicKey); err != nil {
		return ErrInvalidPublicKey
	}

	fleetNet, err := netip.ParsePrefix(FleetOverlayCIDR)
	if err != nil {
		return fmt.Errorf("invalid fleet overlay CIDR constant: %w", err)
	}

	addrPrefix, err := netip.ParsePrefix(strings.TrimSpace(desired.AddressCIDR))
	if err != nil {
		return ErrInvalidAddressCIDR
	}
	// Prefix must be within 10.77.0.0/24 and have bits >= 24
	if !fleetNet.Contains(addrPrefix.Addr()) || addrPrefix.Bits() < 24 || addrPrefix.Bits() > 32 {
		return ErrSubnetMismatch
	}

	// Prohibit network (10.77.0.0), controller (.1), and broadcast (10.77.0.255)
	addrStr := addrPrefix.Addr().String()
	if addrStr == "10.77.0.0" || addrStr == DefaultControllerOverlayIP || addrStr == "10.77.0.255" {
		return fmt.Errorf("%w: worker address cannot be %s", ErrSubnetMismatch, addrStr)
	}

	host, portStr, err := net.SplitHostPort(strings.TrimSpace(desired.ControllerEndpoint))
	if err != nil || host == "" {
		return ErrInvalidEndpoint
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port <= 0 || port > 65535 {
		return ErrInvalidEndpoint
	}

	if len(desired.AllowedIPs) == 0 {
		return ErrInvalidAllowedIPs
	}
	hasControllerRoute := false
	for _, ip := range desired.AllowedIPs {
		trimmedIP := strings.TrimSpace(ip)
		if trimmedIP == "0.0.0.0/0" || trimmedIP == "::/0" {
			return ErrDefaultRouteForbidden
		}
		prefix, err := netip.ParsePrefix(trimmedIP)
		if err != nil {
			return ErrInvalidAllowedIPs
		}
		// Require each allowed route to be strictly within 10.77.0.0/24 with prefix length >= 24
		// Rejects 10.77.0.0/8 or 10.77.0.0/16 escaping the /24 overlay
		if !fleetNet.Contains(prefix.Addr()) || prefix.Bits() < 24 || prefix.Bits() > 32 {
			return fmt.Errorf("%w: route %s escapes 10.77.0.0/24", ErrSubnetMismatch, trimmedIP)
		}
		controllerIP, _ := netip.ParseAddr(DefaultControllerOverlayIP)
		if prefix.Contains(controllerIP) {
			hasControllerRoute = true
		}
	}

	if !hasControllerRoute {
		return fmt.Errorf("%w: allowed IPs must route controller overlay IP 10.77.0.1", ErrInvalidAllowedIPs)
	}

	if desired.MTU != nil {
		if *desired.MTU < MinMTU || *desired.MTU > MaxMTU {
			return ErrInvalidMTU
		}
	}
	return nil
}

func (m *Manager) ConfigPath(ifaceName string) string {
	name := strings.TrimSpace(ifaceName)
	if name == "" {
		name = DefaultInterfaceName
	}
	cleanName := filepath.Base(name)
	return filepath.Join(m.configDir, cleanName+ConfigFileExt)
}

func (m *Manager) RecoveryStatePath() string {
	return filepath.Join(m.configDir, RecoveryStateFilename)
}

func (m *Manager) DesiredStatePath() string {
	return filepath.Join(m.configDir, DesiredStateFilename)
}

func (m *Manager) OwnershipMarkerPath() string {
	return filepath.Join(m.configDir, OwnershipMarkerFilename)
}

func (m *Manager) loadPersistedDesired() error {
	data, err := os.ReadFile(m.DesiredStatePath())
	if err != nil {
		return err
	}
	var d Desired
	if err := json.Unmarshal(data, &d); err != nil {
		return err
	}
	// Verify persisted desired matches ownership marker
	marker, err := m.loadOwnershipMarker()
	if err != nil || marker == nil {
		return fmt.Errorf("%w: persisted desired without ownership marker", ErrForeignOwnership)
	}
	if marker.InterfaceName != d.InterfaceName || marker.ControllerPublicKey != d.ControllerPublicKey {
		return fmt.Errorf("%w: persisted desired mismatches ownership marker", ErrForeignOwnership)
	}
	m.latestDesired = &d
	return nil
}

func (m *Manager) savePersistedDesired(d Desired) error {
	data, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return writeRestrictedAtomic(m.configDir, m.DesiredStatePath(), data)
}

func (m *Manager) loadOwnershipMarker() (*OwnershipMarker, error) {
	data, err := os.ReadFile(m.OwnershipMarkerPath())
	if err != nil {
		return nil, err
	}
	var marker OwnershipMarker
	if err := json.Unmarshal(data, &marker); err != nil {
		return nil, err
	}
	return &marker, nil
}

func (m *Manager) saveOwnershipMarker(d Desired) error {
	marker := OwnershipMarker{
		InterfaceName:       d.InterfaceName,
		ControllerPublicKey: d.ControllerPublicKey,
		AddressCIDR:         d.AddressCIDR,
		CreatedAt:           time.Now().UnixMilli(),
	}
	data, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return err
	}
	return writeRestrictedAtomic(m.configDir, m.OwnershipMarkerPath(), data)
}

func (m *Manager) loadRecoveryState() (PersistedRecoveryState, error) {
	data, err := os.ReadFile(m.RecoveryStatePath())
	if err != nil {
		if os.IsNotExist(err) {
			return PersistedRecoveryState{}, nil
		}
		// Unreadable state: fail closed
		return PersistedRecoveryState{
			ConsecutiveFailures: RequiredFailureCycles,
			LastRecoveryAt:      time.Now().UnixMilli(),
		}, fmt.Errorf("read recovery state error: %w", err)
	}
	var state PersistedRecoveryState
	if err := json.Unmarshal(data, &state); err != nil {
		// Corrupt JSON: fail closed
		return PersistedRecoveryState{
			ConsecutiveFailures: RequiredFailureCycles,
			LastRecoveryAt:      time.Now().UnixMilli(),
		}, fmt.Errorf("corrupt recovery state JSON: %w", err)
	}
	return state, nil
}

func (m *Manager) saveRecoveryState(state PersistedRecoveryState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("%w: marshal error: %v", ErrStatePersistFailed, err)
	}
	if err := writeRestrictedAtomic(m.configDir, m.RecoveryStatePath(), data); err != nil {
		return fmt.Errorf("%w: write error: %v", ErrStatePersistFailed, err)
	}
	return nil
}

func (m *Manager) verifyExistingOwnership(ctx context.Context, desired Desired) error {
	ifaceName := desired.InterfaceName

	// 1. Verify marker file if exists
	marker, err := m.loadOwnershipMarker()
	if err == nil && marker != nil {
		if marker.InterfaceName != ifaceName {
			return fmt.Errorf("%w: marker interface %s != %s", ErrForeignOwnership, marker.InterfaceName, ifaceName)
		}
		if marker.ControllerPublicKey != desired.ControllerPublicKey {
			return fmt.Errorf("%w: marker controller public key mismatch", ErrForeignOwnership)
		}
		if marker.AddressCIDR != desired.AddressCIDR {
			return fmt.Errorf("%w: marker overlay address mismatch", ErrForeignOwnership)
		}
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("%w: unreadable ownership marker: %v", ErrForeignOwnership, err)
	}

	// 2. Check local configuration file if exists
	confPath := m.ConfigPath(ifaceName)
	if existingData, err := os.ReadFile(confPath); err == nil {
		if marker == nil {
			return fmt.Errorf("%w: existing configuration lacks durable ownership marker", ErrForeignOwnership)
		}
		content := string(existingData)
		if !strings.HasPrefix(content, OwnedHeaderPrefix) {
			return fmt.Errorf("%w: existing config file %s lacks ownership header", ErrForeignOwnership, confPath)
		}
		matchedPeer := false
		for _, line := range strings.Split(content, "\n") {
			key, value, ok := strings.Cut(line, "=")
			if ok && strings.TrimSpace(key) == "PublicKey" && strings.TrimSpace(value) == desired.ControllerPublicKey {
				matchedPeer = true
			}
		}
		if !matchedPeer {
			return fmt.Errorf("%w: configured controller public key mismatch", ErrForeignOwnership)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("%w: unreadable existing config %s: %v", ErrForeignOwnership, confPath, err)
	}

	// 3. Check running kernel interface if exists
	if m.backend != nil {
		dump, err := m.backend.ReadDump(ctx, ifaceName)
		if err != nil {
			if _, interfaceErr := net.InterfaceByName(ifaceName); interfaceErr == nil {
				return fmt.Errorf("%w: running interface cannot be verified", ErrForeignOwnership)
			}
		} else if strings.TrimSpace(dump) != "" {
			if marker == nil {
				return fmt.Errorf("%w: running interface lacks durable ownership marker", ErrForeignOwnership)
			}
			parsed, parseErr := parseDump(dump, &desired)
			if parseErr != nil || !parsed.PeerFound {
				return fmt.Errorf("%w: running controller peer identity mismatch", ErrForeignOwnership)
			}
		}
	}

	return nil
}

func (m *Manager) Reconcile(ctx context.Context, desired Desired, privateKey string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if desired.InterfaceName == "" {
		desired.InterfaceName = DefaultInterfaceName
	}
	if desired.PersistentKeepaliveSeconds <= 0 {
		desired.PersistentKeepaliveSeconds = DefaultKeepaliveSeconds
	}

	if err := ValidateDesired(desired, privateKey); err != nil {
		return err
	}

	if m.backend == nil {
		return ErrUnsupportedPlatform
	}

	if err := m.backend.DetectTools(); err != nil {
		return fmt.Errorf("tool detection failed: %w", err)
	}

	// Ownership validation BEFORE any write or modification
	if err := m.verifyExistingOwnership(ctx, desired); err != nil {
		return err
	}

	confPath := m.ConfigPath(desired.InterfaceName)

	// Keep existing config as backup for rollback if configure fails
	var backupData []byte
	hadExistingConfig := false
	if data, err := os.ReadFile(confPath); err == nil {
		backupData = data
		hadExistingConfig = true
	}

	confContent := buildConfigFile(desired, privateKey)
	if err := writeRestrictedAtomic(m.configDir, confPath, []byte(confContent)); err != nil {
		return fmt.Errorf("failed to write owned config: %w", err)
	}

	// Apply configuration natively
	if err := m.backend.ConfigureInterface(ctx, confPath, desired); err != nil {
		// Rollback local config file
		if hadExistingConfig {
			_ = writeRestrictedAtomic(m.configDir, confPath, backupData)
		} else {
			_ = os.Remove(confPath)
		}
		return fmt.Errorf("failed to configure interface %s: %w", desired.InterfaceName, err)
	}

	// Persist desired state and ownership marker
	if err := m.saveOwnershipMarker(desired); err != nil {
		return fmt.Errorf("%w: marker save error: %v", ErrStatePersistFailed, err)
	}
	if err := m.savePersistedDesired(desired); err != nil {
		return fmt.Errorf("%w: desired save error: %v", ErrStatePersistFailed, err)
	}
	m.latestDesired = &desired

	return nil
}

// Observe is strictly read-only: inspects interface, peer, and runs probe.
// It NEVER mutates recovery state, config, or failure counters.
func (m *Manager) Observe(ctx context.Context) Observation {
	m.mu.Lock()
	backend := m.backend
	desired := m.latestDesired
	configDir := m.configDir
	recState, _ := m.loadRecoveryState()
	m.mu.Unlock()

	fFalse := false
	fTrue := true
	obs := Observation{
		State:            "unknown",
		InterfacePresent: &fFalse,
		PeerPresent:      &fFalse,
	}
	if recState.LastRecoveryAt > 0 {
		obs.LastRecoveryAt = &recState.LastRecoveryAt
	}

	if backend == nil {
		errStr := ErrUnsupportedPlatform.Error()
		obs.Error = &errStr
		return obs
	}

	if err := backend.DetectTools(); err != nil {
		errStr := fmt.Sprintf("tools missing: %v", err)
		obs.Error = &errStr
		return obs
	}

	if desired == nil {
		if err := m.loadPersistedDesired(); err != nil || m.latestDesired == nil {
			errStr := ErrMissingDesiredState.Error()
			obs.Error = &errStr
			return obs
		}
		m.mu.Lock()
		desired = m.latestDesired
		m.mu.Unlock()
	}

	ifaceName := desired.InterfaceName
	confPath := filepath.Join(configDir, ifaceName+ConfigFileExt)
	confData, err := os.ReadFile(confPath)
	if err != nil {
		errStr := "owned configuration file not found"
		obs.Error = &errStr
		return obs
	}
	if !strings.HasPrefix(string(confData), OwnedHeaderPrefix) {
		errStr := "configuration file missing proxyfleet ownership header"
		obs.Error = &errStr
		return obs
	}

	dump, err := backend.ReadDump(ctx, ifaceName)
	if err != nil {
		errStr := fmt.Sprintf("interface %s read failed: %v", ifaceName, err)
		obs.Error = &errStr
		return obs
	}

	obs.InterfacePresent = &fTrue
	parsed, err := parseDump(dump, desired)
	if err != nil {
		errStr := fmt.Sprintf("dump parse error: %v", err)
		obs.Error = &errStr
		return obs
	}

	if parsed.PeerFound {
		obs.PeerPresent = &fTrue
		obs.RxBytes = &parsed.RxBytes
		obs.TxBytes = &parsed.TxBytes
		if parsed.LastHandshakeSec > 0 {
			ms := parsed.LastHandshakeSec * 1000
			obs.LastHandshakeAt = &ms
		}

		// Active probe to controller overlay IP (10.77.0.1)
		targetIP := DefaultControllerOverlayIP
		if m.prober != nil {
			probeErr := m.prober.Probe(ctx, targetIP)
			if probeErr == nil {
				obs.ProbeOk = &fTrue
				obs.State = "healthy"
			} else {
				obs.ProbeOk = &fFalse
				obs.State = "unhealthy"
				errStr := fmt.Sprintf("overlay probe to %s failed: %v", targetIP, probeErr)
				obs.Error = &errStr
			}
		} else {
			obs.State = "unknown"
			errStr := "no prober configured"
			obs.Error = &errStr
		}
	} else {
		obs.State = "unhealthy"
		errStr := "no peers present on owned interface"
		obs.Error = &errStr
	}

	return obs
}

// RecordCycleResult updates consecutive failure counter once per serialized normal agent cycle.
// Fails closed if persisting state to disk fails.
func (m *Manager) RecordCycleResult(probeOk bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	recState, _ := m.loadRecoveryState()
	if probeOk {
		if recState.ConsecutiveFailures == 0 {
			return nil
		}
		recState.ConsecutiveFailures = 0
	} else {
		recState.ConsecutiveFailures++
	}
	return m.saveRecoveryState(recState)
}

// RecordSuccess resets consecutive failure counter to 0.
func (m *Manager) RecordSuccess() error {
	return m.RecordCycleResult(true)
}

// RecordFailure increments consecutive failure counter by 1.
func (m *Manager) RecordFailure() error {
	return m.RecordCycleResult(false)
}

func (m *Manager) Recover(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	recState, err := m.loadRecoveryState()
	if err != nil {
		// Corrupted or unreadable state fails closed
		return fmt.Errorf("%w: recovery state unreadable: %v", ErrRecoveryCooldown, err)
	}

	nowMs := time.Now().UnixMilli()

	if recState.ConsecutiveFailures < RequiredFailureCycles {
		return fmt.Errorf("%w: failure %d of %d", ErrThresholdNotMet, recState.ConsecutiveFailures, RequiredFailureCycles)
	}

	if recState.LastRecoveryAt > 0 {
		cooldownMs := RecoveryCooldownDuration.Milliseconds()
		if nowMs-recState.LastRecoveryAt < cooldownMs {
			return ErrRecoveryCooldown
		}
	}

	if m.backend == nil {
		return ErrUnsupportedPlatform
	}

	if m.latestDesired == nil {
		if err := m.loadPersistedDesired(); err != nil || m.latestDesired == nil {
			return ErrMissingDesiredState
		}
	}

	desired := *m.latestDesired
	confPath := m.ConfigPath(desired.InterfaceName)

	// Validate ownership marker before executing native restart
	if err := m.verifyExistingOwnership(ctx, desired); err != nil {
		return fmt.Errorf("ownership validation failed before restart: %w", err)
	}

	// CRITICAL: Persist attempt cooldown timestamp BEFORE running restart command.
	// If saving recovery state fails, fail closed and abort native restart!
	recState.LastRecoveryAt = nowMs
	if err := m.saveRecoveryState(recState); err != nil {
		return fmt.Errorf("aborting recovery: %w", err)
	}

	if err := m.backend.RestartInterface(ctx, confPath, desired); err != nil {
		return fmt.Errorf("recovery restart failed: %w", err)
	}

	// On successful restart, reset consecutive failure counter
	recState.ConsecutiveFailures = 0
	return m.saveRecoveryState(recState)
}

func buildConfigFile(desired Desired, privateKey string) string {
	var sb strings.Builder
	sb.WriteString(OwnedHeaderPrefix + "\n")
	sb.WriteString(fmt.Sprintf("# ControllerPublicKey = %s\n", strings.TrimSpace(desired.ControllerPublicKey)))
	sb.WriteString("[Interface]\n")
	sb.WriteString(fmt.Sprintf("PrivateKey = %s\n", strings.TrimSpace(privateKey)))
	sb.WriteString(fmt.Sprintf("Address = %s\n", strings.TrimSpace(desired.AddressCIDR)))
	if desired.MTU != nil && *desired.MTU > 0 {
		sb.WriteString(fmt.Sprintf("MTU = %d\n", *desired.MTU))
	}
	sb.WriteString("\n[Peer]\n")
	sb.WriteString(fmt.Sprintf("PublicKey = %s\n", strings.TrimSpace(desired.ControllerPublicKey)))
	sb.WriteString(fmt.Sprintf("Endpoint = %s\n", strings.TrimSpace(desired.ControllerEndpoint)))
	sb.WriteString(fmt.Sprintf("AllowedIPs = %s\n", strings.Join(desired.AllowedIPs, ", ")))
	if desired.PersistentKeepaliveSeconds > 0 {
		sb.WriteString(fmt.Sprintf("PersistentKeepalive = %d\n", desired.PersistentKeepaliveSeconds))
	}
	return sb.String()
}

type parsedDump struct {
	PeerFound        bool
	LastHandshakeSec int64
	RxBytes          int64
	TxBytes          int64
}

func parseDump(dump string, desired *Desired) (parsedDump, error) {
	if desired == nil || desired.ControllerPublicKey == "" {
		return parsedDump{}, errors.New("cannot parse dump without desired controller public key")
	}

	lines := strings.Split(strings.TrimSpace(dump), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return parsedDump{}, errors.New("empty dump")
	}

	// Line 0 is Interface: private_key public_key listen_port fwmark (EXACTLY 4 tab-separated fields)
	headerParts := strings.Split(strings.TrimSpace(lines[0]), "\t")
	if len(headerParts) != 4 {
		return parsedDump{}, fmt.Errorf("malformed interface dump header: expected exactly 4 fields, got %d", len(headerParts))
	}

	var res parsedDump
	// Lines 1.. are Peers: public_key preshared_key endpoint allowed_ips latest_handshake transfer_rx transfer_tx persistent_keepalive (EXACTLY 8 fields)
	for _, rawLine := range lines[1:] {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) != 8 {
			return parsedDump{}, fmt.Errorf("malformed peer line: expected exactly 8 fields, got %d", len(parts))
		}
		pubKey := strings.TrimSpace(parts[0])
		if subtle.ConstantTimeCompare([]byte(pubKey), []byte(strings.TrimSpace(desired.ControllerPublicKey))) != 1 {
			continue
		}
		res.PeerFound = true
		hs, err := strconv.ParseInt(strings.TrimSpace(parts[4]), 10, 64)
		if err != nil || hs < 0 {
			return parsedDump{}, fmt.Errorf("invalid handshake timestamp %q: must be non-negative integer", parts[4])
		}
		res.LastHandshakeSec = hs

		rx, err := strconv.ParseInt(strings.TrimSpace(parts[5]), 10, 64)
		if err != nil || rx < 0 {
			return parsedDump{}, fmt.Errorf("invalid rx bytes %q: must be non-negative integer", parts[5])
		}
		res.RxBytes = rx

		tx, err := strconv.ParseInt(strings.TrimSpace(parts[6]), 10, 64)
		if err != nil || tx < 0 {
			return parsedDump{}, fmt.Errorf("invalid tx bytes %q: must be non-negative integer", parts[6])
		}
		res.TxBytes = tx
		break
	}
	return res, nil
}

type defaultProber struct{}

func (p *defaultProber) Probe(ctx context.Context, target string) error {
	dialer := net.Dialer{Timeout: 3 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(target, "1300"))
	if err == nil {
		_ = conn.Close()
		return nil
	}
	return err
}

func sanitizeDiagnosticOutput(output string) string {
	// Mask base64 keys (32+ base64 chars with optional padding)
	keyPattern := regexp.MustCompile(`[a-zA-Z0-9+/]{32,}={0,2}`)
	sanitized := keyPattern.ReplaceAllString(output, "[REDACTED_KEY]")
	trimmed := strings.TrimSpace(sanitized)
	if len(trimmed) > MaxDiagnosticLength {
		return trimmed[:MaxDiagnosticLength] + "...[truncated]"
	}
	return trimmed
}
