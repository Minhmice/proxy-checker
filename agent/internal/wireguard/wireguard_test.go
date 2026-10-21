package wireguard

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type mockBackend struct {
	detectErr   error
	dumpOutput  string
	dumpErr     error
	reconfigErr error
	removeErr   error
	restartErr  error
	restarts    int
	configured  int
}

func (m *mockBackend) DetectTools() error {
	return m.detectErr
}

func (m *mockBackend) ConfigureInterface(ctx context.Context, confPath string, desired Desired) error {
	m.configured++
	return m.reconfigErr
}

func (m *mockBackend) RemoveInterface(ctx context.Context, ifaceName string) error {
	return m.removeErr
}

func (m *mockBackend) ReadDump(ctx context.Context, ifaceName string) (string, error) {
	if m.dumpErr != nil {
		return "", m.dumpErr
	}
	return m.dumpOutput, nil
}

func (m *mockBackend) RestartInterface(ctx context.Context, confPath string, desired Desired) error {
	m.restarts++
	return m.restartErr
}

type mockProber struct {
	err          error
	probedTarget string
}

func (p *mockProber) Probe(ctx context.Context, target string) error {
	p.probedTarget = target
	return p.err
}

func generateValidKey(t *testing.T) string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand read error: %v", err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func TestValidation(t *testing.T) {
	privKey := generateValidKey(t)
	pubKey := generateValidKey(t)

	// Valid baseline
	validDesired := Desired{
		InterfaceName:              "proxyfleet",
		AddressCIDR:                "10.77.0.2/24",
		ControllerPublicKey:        pubKey,
		ControllerEndpoint:         "198.51.100.1:51820",
		AllowedIPs:                 []string{"10.77.0.1/32"},
		PersistentKeepaliveSeconds: 25,
	}

	if err := ValidateDesired(validDesired, privKey); err != nil {
		t.Fatalf("expected valid desired to pass, got: %v", err)
	}

	// Invalid Interface Name: escapes or different name
	badName := validDesired
	badName.InterfaceName = "wg0"
	if err := ValidateDesired(badName, privKey); !errors.Is(err, ErrInvalidInterfaceName) {
		t.Errorf("expected ErrInvalidInterfaceName for 'wg0', got: %v", err)
	}

	pathEscape := validDesired
	pathEscape.InterfaceName = "../other"
	if err := ValidateDesired(pathEscape, privKey); !errors.Is(err, ErrInvalidInterfaceName) {
		t.Errorf("expected ErrInvalidInterfaceName for '../other', got: %v", err)
	}

	// Address outside overlay (192.168.1.2/24)
	outOfSubnet := validDesired
	outOfSubnet.AddressCIDR = "192.168.1.2/24"
	if err := ValidateDesired(outOfSubnet, privKey); !errors.Is(err, ErrSubnetMismatch) {
		t.Errorf("expected ErrSubnetMismatch for 192.168.1.2/24, got: %v", err)
	}

	// Prohibited controller overlay address (10.77.0.1) as worker address
	controllerIPAsWorker := validDesired
	controllerIPAsWorker.AddressCIDR = "10.77.0.1/24"
	if err := ValidateDesired(controllerIPAsWorker, privKey); !errors.Is(err, ErrSubnetMismatch) {
		t.Errorf("expected ErrSubnetMismatch for worker using 10.77.0.1, got: %v", err)
	}

	// Prohibited network address (10.77.0.0)
	netAddrAsWorker := validDesired
	netAddrAsWorker.AddressCIDR = "10.77.0.0/24"
	if err := ValidateDesired(netAddrAsWorker, privKey); !errors.Is(err, ErrSubnetMismatch) {
		t.Errorf("expected ErrSubnetMismatch for worker using 10.77.0.0, got: %v", err)
	}

	// Prohibited default route 0.0.0.0/0
	defaultRoute := validDesired
	defaultRoute.AllowedIPs = []string{"0.0.0.0/0"}
	if err := ValidateDesired(defaultRoute, privKey); !errors.Is(err, ErrDefaultRouteForbidden) {
		t.Errorf("expected ErrDefaultRouteForbidden for 0.0.0.0/0, got: %v", err)
	}

	// Prohibited default IPv6 route ::/0
	defaultIPv6Route := validDesired
	defaultIPv6Route.AllowedIPs = []string{"::/0"}
	if err := ValidateDesired(defaultIPv6Route, privKey); !errors.Is(err, ErrDefaultRouteForbidden) {
		t.Errorf("expected ErrDefaultRouteForbidden for ::/0, got: %v", err)
	}

	// AllowedIPs escaping overlay (/8)
	slash8Route := validDesired
	slash8Route.AllowedIPs = []string{"10.77.0.0/8"}
	if err := ValidateDesired(slash8Route, privKey); !errors.Is(err, ErrSubnetMismatch) {
		t.Errorf("expected ErrSubnetMismatch for 10.77.0.0/8 escaping /24 overlay, got: %v", err)
	}

	// AllowedIPs escaping overlay (/16)
	slash16Route := validDesired
	slash16Route.AllowedIPs = []string{"10.77.0.0/16"}
	if err := ValidateDesired(slash16Route, privKey); !errors.Is(err, ErrSubnetMismatch) {
		t.Errorf("expected ErrSubnetMismatch for 10.77.0.0/16 escaping /24 overlay, got: %v", err)
	}

	// AllowedIPs outside fleet overlay
	foreignAllowed := validDesired
	foreignAllowed.AllowedIPs = []string{"192.168.0.0/24"}
	if err := ValidateDesired(foreignAllowed, privKey); !errors.Is(err, ErrSubnetMismatch) {
		t.Errorf("expected ErrSubnetMismatch for foreign allowed IP, got: %v", err)
	}
}

func TestDumpParser(t *testing.T) {
	pubKey := generateValidKey(t)
	desired := &Desired{
		ControllerPublicKey: pubKey,
	}

	// Valid dump with 4 header fields and exactly 8 peer fields
	dump := fmt.Sprintf("dummy_priv\tdummy_pub\t51820\toff\n%s\t(none)\t198.51.100.1:51820\t10.77.0.1/32\t1729160000\t1048576\t2097152\t25", pubKey)
	parsed, err := parseDump(dump, desired)
	if err != nil {
		t.Fatalf("parseDump error: %v", err)
	}
	if !parsed.PeerFound {
		t.Error("expected PeerFound == true")
	}
	if parsed.LastHandshakeSec != 1729160000 {
		t.Errorf("expected handshake 1729160000, got %d", parsed.LastHandshakeSec)
	}
	if parsed.RxBytes != 1048576 || parsed.TxBytes != 2097152 {
		t.Errorf("expected rx 1048576 tx 2097152, got rx %d tx %d", parsed.RxBytes, parsed.TxBytes)
	}

	// Malformed header (less than 4 fields)
	badHeaderDump := fmt.Sprintf("dummy_priv\tdummy_pub\n%s\t(none)\t198.51.100.1:51820\t10.77.0.1/32\t1729160000\t1048576\t2097152\t25", pubKey)
	if _, err := parseDump(badHeaderDump, desired); err == nil {
		t.Error("expected error on malformed dump header (< 4 fields)")
	}

	// Malformed header (> 4 fields)
	longHeaderDump := fmt.Sprintf("dummy_priv\tdummy_pub\t51820\toff\textra\n%s\t(none)\t198.51.100.1:51820\t10.77.0.1/32\t1729160000\t1048576\t2097152\t25", pubKey)
	if _, err := parseDump(longHeaderDump, desired); err == nil {
		t.Error("expected error on dump header with > 4 fields")
	}

	// Malformed peer line (7 fields instead of 8)
	shortPeerDump := fmt.Sprintf("dummy_priv\tdummy_pub\t51820\toff\n%s\t(none)\t198.51.100.1:51820\t10.77.0.1/32\t1729160000\t1048576\t2097152", pubKey)
	if _, err := parseDump(shortPeerDump, desired); err == nil {
		t.Error("expected error on peer line with 7 fields")
	}

	// Malformed peer line (9 fields instead of 8)
	longPeerDump := fmt.Sprintf("dummy_priv\tdummy_pub\t51820\toff\n%s\t(none)\t198.51.100.1:51820\t10.77.0.1/32\t1729160000\t1048576\t2097152\t25\textra", pubKey)
	if _, err := parseDump(longPeerDump, desired); err == nil {
		t.Error("expected error on peer line with 9 fields")
	}

	// Malformed numeric field (negative number)
	negativeNumDump := fmt.Sprintf("dummy_priv\tdummy_pub\t51820\toff\n%s\t(none)\t198.51.100.1:51820\t10.77.0.1/32\t-1\t1048576\t2097152\t25", pubKey)
	if _, err := parseDump(negativeNumDump, desired); err == nil {
		t.Error("expected error on negative handshake timestamp")
	}
}

func TestForeignOwnershipRejection(t *testing.T) {
	tmpDir := t.TempDir()
	pubKey := generateValidKey(t)
	privKey := generateValidKey(t)

	desired := Desired{
		InterfaceName:              "proxyfleet",
		AddressCIDR:                "10.77.0.2/24",
		ControllerPublicKey:        pubKey,
		ControllerEndpoint:         "198.51.100.1:51820",
		AllowedIPs:                 []string{"10.77.0.1/32"},
		PersistentKeepaliveSeconds: 25,
	}

	m := NewManager(tmpDir)
	mock := &mockBackend{}
	m.backend = mock

	// Case 1: Existing foreign config file without ownership header
	foreignConfPath := filepath.Join(tmpDir, "proxyfleet.conf")
	_ = os.WriteFile(foreignConfPath, []byte("[Interface]\nPrivateKey = some_foreign_key\n"), 0600)

	err := m.Reconcile(context.Background(), desired, privKey)
	if !errors.Is(err, ErrForeignOwnership) {
		t.Fatalf("expected ErrForeignOwnership when config lacks header, got: %v", err)
	}

	// Case 2: Running interface with different controller public key
	_ = os.Remove(foreignConfPath)
	foreignKey := generateValidKey(t)
	mock.dumpOutput = fmt.Sprintf("dummy_priv\tdummy_pub\t51820\toff\n%s\t(none)\t198.51.100.1:51820\t10.77.0.1/32\t1729160000\t1048576\t2097152\t25", foreignKey)

	err = m.Reconcile(context.Background(), desired, privKey)
	if !errors.Is(err, ErrForeignOwnership) {
		t.Fatalf("expected ErrForeignOwnership for running interface mismatch, got: %v", err)
	}
}

func TestObserve_ReadOnlyAndProbeTarget(t *testing.T) {
	tmpDir := t.TempDir()
	pubKey := generateValidKey(t)
	privKey := generateValidKey(t)

	desired := Desired{
		InterfaceName:              "proxyfleet",
		AddressCIDR:                "10.77.0.2/24",
		ControllerPublicKey:        pubKey,
		ControllerEndpoint:         "198.51.100.1:51820",
		AllowedIPs:                 []string{"10.77.0.1/32"},
		PersistentKeepaliveSeconds: 25,
	}

	m := NewManager(tmpDir)
	mock := &mockBackend{}
	m.backend = mock

	if err := m.Reconcile(context.Background(), desired, privKey); err != nil {
		t.Fatalf("reconcile failed: %v", err)
	}

	mock.dumpOutput = fmt.Sprintf("dummy_priv\tdummy_pub\t51820\toff\n%s\t(none)\t198.51.100.1:51820\t10.77.0.1/32\t1729160000\t1048576\t2097152\t25", pubKey)

	// Probe fails: must report unhealthy even if handshake and rx bytes are positive!
	prober := &mockProber{err: errors.New("timeout")}
	m.prober = prober

	// Call Observe multiple times to verify it is strictly read-only
	for range 5 {
		obs := m.Observe(context.Background())
		if obs.State != "unhealthy" {
			t.Errorf("expected State == 'unhealthy' on probe failure, got: %s", obs.State)
		}
		if prober.probedTarget != "10.77.0.1" {
			t.Errorf("expected probe target to be 10.77.0.1, got: %s", prober.probedTarget)
		}
	}

	// Verify Observe did NOT increment consecutive failures (read-only verification!)
	recState, _ := m.loadRecoveryState()
	if recState.ConsecutiveFailures != 0 {
		t.Errorf("Observe must be read-only; expected consecutiveFailures == 0, got %d", recState.ConsecutiveFailures)
	}

	// Caller records cycle result explicitly
	if err := m.RecordCycleResult(false); err != nil {
		t.Fatalf("record cycle failure error: %v", err)
	}
	recState, _ = m.loadRecoveryState()
	if recState.ConsecutiveFailures != 1 {
		t.Errorf("expected consecutiveFailures == 1 after RecordCycleResult(false), got %d", recState.ConsecutiveFailures)
	}

	// Probe succeeds: RecordCycleResult(true) resets failures
	prober.err = nil
	obs := m.Observe(context.Background())
	if obs.State != "healthy" {
		t.Errorf("expected State == 'healthy' on probe success, got: %s", obs.State)
	}
	if err := m.RecordCycleResult(true); err != nil {
		t.Fatalf("record cycle success error: %v", err)
	}
	recState, _ = m.loadRecoveryState()
	if recState.ConsecutiveFailures != 0 {
		t.Errorf("expected consecutiveFailures == 0 after success, got %d", recState.ConsecutiveFailures)
	}
}

func TestRecovery_CooldownPersistedBeforeRestart(t *testing.T) {
	tmpDir := t.TempDir()
	pubKey := generateValidKey(t)
	privKey := generateValidKey(t)

	desired := Desired{
		InterfaceName:              "proxyfleet",
		AddressCIDR:                "10.77.0.2/24",
		ControllerPublicKey:        pubKey,
		ControllerEndpoint:         "198.51.100.1:51820",
		AllowedIPs:                 []string{"10.77.0.1/32"},
		PersistentKeepaliveSeconds: 25,
	}

	m := NewManager(tmpDir)
	mock := &mockBackend{}
	m.backend = mock
	_ = m.Reconcile(context.Background(), desired, privKey)

	// Set failures to 3 manually
	_ = m.saveRecoveryState(PersistedRecoveryState{ConsecutiveFailures: 3, LastRecoveryAt: 0})

	// Make restart fail
	mock.restartErr = errors.New("hardware bus error")

	err := m.Recover(context.Background())
	if err == nil {
		t.Fatal("expected error from failed restart")
	}

	// CRITICAL TEST: LastRecoveryAt must be persisted even though restart failed!
	recState, _ := m.loadRecoveryState()
	if recState.LastRecoveryAt == 0 {
		t.Fatal("LastRecoveryAt was not persisted before failed restart attempt")
	}

	// Subsequent recovery attempt immediately after must fail with ErrRecoveryCooldown
	err = m.Recover(context.Background())
	if !errors.Is(err, ErrRecoveryCooldown) {
		t.Fatalf("expected ErrRecoveryCooldown on immediate retry, got: %v", err)
	}
}

func TestDurableDesiredPersistence(t *testing.T) {
	tmpDir := t.TempDir()
	pubKey := generateValidKey(t)
	privKey := generateValidKey(t)

	desired := Desired{
		InterfaceName:              "proxyfleet",
		AddressCIDR:                "10.77.0.2/24",
		ControllerPublicKey:        pubKey,
		ControllerEndpoint:         "198.51.100.1:51820",
		AllowedIPs:                 []string{"10.77.0.1/32"},
		PersistentKeepaliveSeconds: 25,
	}

	m := NewManager(tmpDir)
	mock := &mockBackend{}
	m.backend = mock
	if err := m.Reconcile(context.Background(), desired, privKey); err != nil {
		t.Fatalf("reconcile error: %v", err)
	}

	// Create fresh Manager instance from same dir (simulating agent restart)
	freshManager := NewManager(tmpDir)
	if freshManager.latestDesired == nil {
		t.Fatal("expected latestDesired to be restored from desired_state.json")
	}
	if freshManager.latestDesired.ControllerPublicKey != pubKey {
		t.Errorf("restored public key mismatch: got %s, want %s", freshManager.latestDesired.ControllerPublicKey, pubKey)
	}
}

func TestSanitizeDiagnosticOutput(t *testing.T) {
	testKey := generateValidKey(t)
	rawDiagnostic := fmt.Sprintf("Error executing: wg set proxyfleet private-key %s peer %s", testKey, testKey)
	sanitized := sanitizeDiagnosticOutput(rawDiagnostic)
	if strings.Contains(sanitized, testKey) {
		t.Errorf("raw key was not redacted by sanitizeDiagnosticOutput: %s", sanitized)
	}
	if !strings.Contains(sanitized, "[REDACTED_KEY]") {
		t.Errorf("expected [REDACTED_KEY] placeholder in output: %s", sanitized)
	}
	// Check max length bounding
	veryLongDiagnostic := strings.Repeat("A", 500)
	bounded := sanitizeDiagnosticOutput(veryLongDiagnostic)
	if len(bounded) > 300 {
		t.Errorf("diagnostic output was not properly bounded, length: %d", len(bounded))
	}
}

func TestConfigRollbackOnConfigureFailure(t *testing.T) {
	tmpDir := t.TempDir()
	pubKey := generateValidKey(t)
	privKey := generateValidKey(t)

	desired := Desired{
		InterfaceName:              "proxyfleet",
		AddressCIDR:                "10.77.0.2/24",
		ControllerPublicKey:        pubKey,
		ControllerEndpoint:         "198.51.100.1:51820",
		AllowedIPs:                 []string{"10.77.0.1/32"},
		PersistentKeepaliveSeconds: 25,
	}

	m := NewManager(tmpDir)
	mock := &mockBackend{}
	m.backend = mock

	// Configure first valid state
	if err := m.Reconcile(context.Background(), desired, privKey); err != nil {
		t.Fatalf("initial reconcile failed: %v", err)
	}

	confPath := m.ConfigPath(desired.InterfaceName)
	initialData, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("failed to read initial config: %v", err)
	}

	// Attempt reconfiguration with failing backend
	mock.reconfigErr = errors.New("native setup failed")
	newPrivKey := generateValidKey(t)
	err = m.Reconcile(context.Background(), desired, newPrivKey)
	if err == nil {
		t.Fatal("expected error on failing configure")
	}

	// Verify local config was rolled back to initialData
	restoredData, err := os.ReadFile(confPath)
	if err != nil {
		t.Fatalf("failed to read restored config: %v", err)
	}
	if string(restoredData) != string(initialData) {
		t.Error("config was not rolled back to initial state after failed configure")
	}
}
