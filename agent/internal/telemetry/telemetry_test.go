package telemetry

import (
	"encoding/json"
	"testing"
	"time"
)

func TestCPUPercentFixture(t *testing.T) {
	// 100 total ticks, 70 idle ticks between samples means 30% utilization.
	previous := cpuCounters{Total: 1000, Idle: 700}
	current := cpuCounters{Total: 1100, Idle: 770}
	value := cpuPercent(previous, current)
	if value == nil || *value != 30 {
		t.Fatalf("want 30%%, got %v", value)
	}
}

func TestCPUPercentEdgeCases(t *testing.T) {
	c1 := cpuCounters{Total: 1000, Idle: 700}
	c2 := cpuCounters{Total: 1000, Idle: 700}
	if v := cpuPercent(c1, c2); v != nil {
		t.Errorf("expected nil when total ticks do not advance, got %v", *v)
	}

	c3 := cpuCounters{Total: 900, Idle: 600}
	if v := cpuPercent(c1, c3); v != nil {
		t.Errorf("expected nil when total ticks regress, got %v", *v)
	}

	c4 := cpuCounters{Total: 1100, Idle: 650}
	if v := cpuPercent(c1, c4); v != nil {
		t.Errorf("expected nil when idle ticks regress, got %v", *v)
	}

	c5 := cpuCounters{Total: 1100, Idle: 800}
	if v := cpuPercent(c1, c5); v == nil || *v != 0.0 {
		t.Errorf("expected 0.0%% when 100%% idle, got %v", v)
	}

	c6 := cpuCounters{Total: 1100, Idle: 700}
	if v := cpuPercent(c1, c6); v == nil || *v != 100.0 {
		t.Errorf("expected 100.0%% when 0 idle advance, got %v", v)
	}
}

func TestParseProcStat(t *testing.T) {
	// Valid /proc/stat
	valid := []byte(`cpu  10132153 290696 2308434 40237912 63312 0 180129 0 0 0
cpu0 1322008 30337 397143 4967390 10633 0 54101 0 0 0
`)
	counters, err := ParseProcStat(valid)
	if err != nil {
		t.Fatalf("unexpected error parsing valid /proc/stat: %v", err)
	}
	expectedIdle := uint64(40237912 + 63312)
	if counters.Idle != expectedIdle {
		t.Errorf("expected idle %d, got %d", expectedIdle, counters.Idle)
	}
	expectedTotal := uint64(10132153 + 290696 + 2308434 + 40237912 + 63312 + 0 + 180129 + 0)
	if counters.Total != expectedTotal {
		t.Errorf("expected total %d, got %d", expectedTotal, counters.Total)
	}

	// Malformed /proc/stat missing aggregate cpu
	missing := []byte(`cpu0 1322008 30337 397143 4967390 10633 0 54101 0 0 0`)
	if _, err := ParseProcStat(missing); err == nil {
		t.Errorf("expected error when cpu aggregate row is missing")
	}

	// Malformed numbers
	corrupted := []byte(`cpu  abc 290696 2308434 40237912 63312 0 180129 0 0 0`)
	if _, err := ParseProcStat(corrupted); err == nil {
		t.Errorf("expected error when required counter contains non-integer")
	}
}

func TestNetworkRateCalculations(t *testing.T) {
	now := time.Now()
	prev := netCounters{
		RxBytes:   10000,
		TxBytes:   20000,
		Timestamp: now,
		Interface: "eth0",
	}

	curr := netCounters{
		RxBytes:   11000,
		TxBytes:   22000,
		Timestamp: now.Add(1 * time.Second),
		Interface: "eth0",
	}
	rxRate, txRate := calculateNetRates(prev, curr)
	if rxRate == nil || *rxRate != 1000.0 {
		t.Errorf("expected rxRate 1000.0, got %v", rxRate)
	}
	if txRate == nil || *txRate != 2000.0 {
		t.Errorf("expected txRate 2000.0, got %v", txRate)
	}

	rebootCurr := netCounters{
		RxBytes:   500,
		TxBytes:   1000,
		Timestamp: now.Add(1 * time.Second),
		Interface: "eth0",
	}
	rRx, rTx := calculateNetRates(prev, rebootCurr)
	if rRx != nil || rTx != nil {
		t.Errorf("expected nil rates on counter regression, got rx=%v tx=%v", rRx, rTx)
	}

	ifaceCurr := netCounters{
		RxBytes:   15000,
		TxBytes:   25000,
		Timestamp: now.Add(1 * time.Second),
		Interface: "wg0",
	}
	iRx, iTx := calculateNetRates(prev, ifaceCurr)
	if iRx != nil || iTx != nil {
		t.Errorf("expected nil rates on interface switch, got rx=%v tx=%v", iRx, iTx)
	}
}

func TestHexPortParsing(t *testing.T) {
	cases := []struct {
		addr string
		port int
	}{
		{"0100007F:044C", 1100}, // 0x044C = 1100
		{"00000000:1F90", 8080}, // 0x1F90 = 8080
		{"00000000:0050", 80},   // 0x0050 = 80
		{"invalid", 0},
		{":", 0},
	}

	for _, c := range cases {
		got := ParseHexPort(c.addr)
		if got != c.port {
			t.Errorf("ParseHexPort(%q) = %d; want %d", c.addr, got, c.port)
		}
	}
}

func TestParseTCPTable(t *testing.T) {
	fixture := `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:044C 0100007F:CD12 01 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 -1
   1: 00000000:044C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000000000000000 100 0 0 10 -1
   2: 0100007F:1F90 0100007F:CD14 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000000000000000 100 0 0 10 -1
   3: 0100007F:D431 0100007F:044C 01 00000000:00000000 00:00000000 00000000  1000        0 12348 1 0000000000000000 100 0 0 10 -1
   4: 0100007F:0016 0100007F:CD16 01 00000000:00000000 00:00000000 00000000  1000        0 12349 1 0000000000000000 100 0 0 10 -1
   5: 0100007F:044C 0100007F:CD18 06 00000000:00000000 00:00000000 00000000  1000        0 12350 1 0000000000000000 100 0 0 10 -1
`

	managedMap := map[int]bool{1100: true, 8080: true}
	listeningMap := make(map[int]bool)

	active, err := ParseTCPTable([]byte(fixture), managedMap, listeningMap)
	if err != nil {
		t.Fatalf("unexpected error parsing tcp table: %v", err)
	}

	// 2 active connections: lines 0 and 2
	if active != 2 {
		t.Fatalf("expected 2 active connections, got %d", active)
	}
	// 1 listening port: 1100
	if len(listeningMap) != 1 || !listeningMap[1100] {
		t.Fatalf("expected 1 listening endpoint on port 1100, got %v", listeningMap)
	}
}

func TestParseWindowsDynamic(t *testing.T) {
	// 1. Successful query with dual-stack listening port already uniquely deduplicated
	activeVal := 3
	listenVal := 1
	ifName := "vEthernet (Default Switch)"
	rx := uint64(1048576)
	tx := uint64(2097152)

	data := `{"Active":3,"Listening":1,"TcpError":null,"SvcStatus":"Running","ProcCount":1,"NetInterface":"vEthernet (Default Switch)","NetRxBytes":1048576,"NetTxBytes":2097152,"NetError":null}`
	active, listen, state, stateErr, netIf, netScope, rxBytes, txBytes, unavail := ParseWindowsDynamic([]byte(data))

	if active == nil || *active != activeVal {
		t.Errorf("expected active %d, got %v", activeVal, active)
	}
	if listen == nil || *listen != listenVal {
		t.Errorf("expected listen %d, got %v", listenVal, listen)
	}
	if state != "running" {
		t.Errorf("expected state running, got %q", state)
	}
	if stateErr != nil {
		t.Errorf("expected nil stateErr, got %v", *stateErr)
	}
	if netIf == nil || *netIf != ifName {
		t.Errorf("expected netIf %q, got %v", ifName, netIf)
	}
	if netScope != "egress" {
		t.Errorf("expected scope egress, got %q", netScope)
	}
	if rxBytes == nil || *rxBytes != rx {
		t.Errorf("expected rx %d, got %v", rx, rxBytes)
	}
	if txBytes == nil || *txBytes != tx {
		t.Errorf("expected tx %d, got %v", tx, txBytes)
	}
	if len(unavail) != 0 {
		t.Errorf("expected 0 unavailable items, got %v", unavail)
	}

	// 2. Query failure: TCP permission denied, service not found -> nil counts and stopped/unknown state
	failData := `{"Active":null,"Listening":null,"TcpError":"Access is denied","SvcStatus":null,"ProcCount":null,"NetInterface":null,"NetRxBytes":0,"NetTxBytes":0,"NetError":"Device not found"}`
	fActive, fListen, fState, _, _, fScope, _, _, fUnavail := ParseWindowsDynamic([]byte(failData))

	if fActive != nil {
		t.Errorf("expected nil active on query failure, got %v", fActive)
	}
	if fListen != nil {
		t.Errorf("expected nil listen on query failure, got %v", fListen)
	}
	if fState != "unknown" {
		t.Errorf("expected state unknown on probe failure, got %q", fState)
	}
	if fScope != "unknown" {
		t.Errorf("expected scope unknown, got %q", fScope)
	}
	if fUnavail["activeConnections"] == "" || fUnavail["network"] == "" {
		t.Errorf("expected unavailable reasons for activeConnections and network, got %v", fUnavail)
	}
}

func TestJSONWireContract(t *testing.T) {
	uptime := uint64(3600)
	cpu := 24.5
	load := 0.45
	memTotal := uint64(8000000000)
	memAvail := uint64(5000000000)
	ifName := "eth0"
	rxBytes := uint64(1048576)
	txBytes := uint64(2097152)
	rxRate := 1024.0
	txRate := 2048.0
	listening := 2
	active := 5
	now := int64(1700000000000)

	snap := Snapshot{
		SampledAt:            now,
		UptimeSeconds:        &uptime,
		CPUPercent:           &cpu,
		LoadAverage1m:        &load,
		MemoryAvailableBytes: &memAvail,
		MemoryTotalBytes:     &memTotal,
		Network: NetworkSnapshot{
			InterfaceName:    &ifName,
			Scope:            "egress",
			RxBytes:          &rxBytes,
			TxBytes:          &txBytes,
			RxBytesPerSecond: &rxRate,
			TxBytesPerSecond: &txRate,
		},
		Proxy: ProxySnapshot{
			State:              "running",
			EnabledEndpoints:   2,
			ListeningEndpoints: &listening,
			ActiveConnections:  &active,
			CheckedAt:          &now,
			Error:              nil,
		},
		Unavailable: map[string]string{
			"debug": "ok",
		},
	}

	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}

	expectedFields := []string{
		"sampledAt", "uptimeSeconds", "cpuPercent", "loadAverage1m",
		"memoryAvailableBytes", "memoryTotalBytes", "network", "proxy", "unavailable",
	}
	for _, f := range expectedFields {
		if _, ok := parsed[f]; !ok {
			t.Errorf("missing expected field in serialized snapshot: %s", f)
		}
	}
}
