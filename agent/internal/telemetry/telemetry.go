package telemetry

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// NetworkSnapshot matches FleetRuntimeSnapshot.network
type NetworkSnapshot struct {
	InterfaceName    *string  `json:"interfaceName"`
	Scope            string   `json:"scope"` // "overlay" | "egress" | "unknown"
	RxBytes          *uint64  `json:"rxBytes"`
	TxBytes          *uint64  `json:"txBytes"`
	RxBytesPerSecond *float64 `json:"rxBytesPerSecond"`
	TxBytesPerSecond *float64 `json:"txBytesPerSecond"`
}

// ProxySnapshot matches FleetRuntimeSnapshot.proxy
type ProxySnapshot struct {
	State              string  `json:"state"` // "running" | "stopped" | "unknown"
	EnabledEndpoints   int     `json:"enabledEndpoints"`
	ListeningEndpoints *int    `json:"listeningEndpoints"`
	ActiveConnections  *int    `json:"activeConnections"`
	CheckedAt          *int64  `json:"checkedAt"`
	Error              *string `json:"error"`
}

// Snapshot matches telemetry subtree of FleetRuntimeSnapshot
type Snapshot struct {
	SampledAt            int64             `json:"sampledAt"` // Unix ms
	UptimeSeconds        *uint64           `json:"uptimeSeconds"`
	CPUPercent           *float64          `json:"cpuPercent"`
	LoadAverage1m        *float64          `json:"loadAverage1m"`
	MemoryAvailableBytes *uint64           `json:"memoryAvailableBytes"`
	MemoryTotalBytes     *uint64           `json:"memoryTotalBytes"`
	Network              NetworkSnapshot   `json:"network"`
	Proxy                ProxySnapshot     `json:"proxy"`
	Unavailable          map[string]string `json:"unavailable"`
}

type cpuCounters struct {
	Total uint64
	Idle  uint64
}

type netCounters struct {
	RxBytes   uint64
	TxBytes   uint64
	Timestamp time.Time
	Interface string
}

// Collector maintains state between metric samples to calculate rates/deltas.
type Collector struct {
	mu      sync.Mutex
	prevCPU *cpuCounters
	prevNet *netCounters
}

// NewCollector creates an initialized dynamic telemetry collector.
func NewCollector() *Collector {
	return &Collector{}
}

// Sample collects dynamic runtime state and calculates utilization/rates.
func (c *Collector) Sample(ctx context.Context, managedPorts []int) Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()

	snap := Snapshot{
		SampledAt: time.Now().UnixMilli(),
		Network: NetworkSnapshot{
			Scope: "unknown",
		},
		Proxy: ProxySnapshot{
			State:            "unknown",
			EnabledEndpoints: len(managedPorts),
		},
		Unavailable: make(map[string]string),
	}

	c.samplePlatform(ctx, managedPorts, &snap)
	return snap
}

// cpuPercent calculates CPU utilization percentage from previous and current tick counters.
// Returns nil when totals regress or do not advance.
func cpuPercent(previous, current cpuCounters) *float64 {
	if current.Total <= previous.Total {
		return nil
	}
	if current.Idle < previous.Idle {
		return nil
	}

	totalDelta := current.Total - previous.Total
	idleDelta := current.Idle - previous.Idle

	if idleDelta > totalDelta {
		return nil
	}

	busyDelta := totalDelta - idleDelta
	pct := (float64(busyDelta) / float64(totalDelta)) * 100.0

	// Round to 2 decimal places and clamp 0..100
	if pct < 0.0 {
		pct = 0.0
	} else if pct > 100.0 {
		pct = 100.0
	}
	rounded := math.Round(pct*100) / 100
	return &rounded
}

// calculateNetRates computes rx/tx bytes per second. Returns nil if interface changed,
// counters regressed, or elapsed time is non-positive.
func calculateNetRates(prev, curr netCounters) (*float64, *float64) {
	if prev.Interface != curr.Interface {
		return nil, nil
	}
	if curr.RxBytes < prev.RxBytes || curr.TxBytes < prev.TxBytes {
		return nil, nil
	}
	elapsed := curr.Timestamp.Sub(prev.Timestamp).Seconds()
	if elapsed <= 0.001 {
		return nil, nil
	}

	rxRate := float64(curr.RxBytes-prev.RxBytes) / elapsed
	txRate := float64(curr.TxBytes-prev.TxBytes) / elapsed

	rxRounded := math.Round(rxRate*100) / 100
	txRounded := math.Round(txRate*100) / 100
	return &rxRounded, &txRounded
}

func addUnavailable(m map[string]string, key, val string) {
	if len(m) >= 32 {
		return
	}
	if len(key) > 64 {
		key = key[:64]
	}
	var sb strings.Builder
	for _, r := range val {
		if r == '\n' || r == '\r' || r == '\t' || (r >= 32 && r != 127) {
			if unicode.IsPrint(r) || r == ' ' {
				sb.WriteRune(r)
			}
		}
	}
	cleaned := strings.TrimSpace(sb.String())
	if len(cleaned) > 256 {
		cleaned = cleaned[:256]
	}
	m[key] = cleaned
}

// ParseProcStat parses aggregate CPU counters from /proc/stat content.
// Rejects malformed counters and returns an error without updating baseline.
func ParseProcStat(data []byte) (cpuCounters, error) {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "cpu ") {
			fields := strings.Fields(line)
			if len(fields) < 5 {
				return cpuCounters{}, errors.New("incomplete cpu line in /proc/stat")
			}
			user, err1 := strconv.ParseUint(fields[1], 10, 64)
			nice, err2 := strconv.ParseUint(fields[2], 10, 64)
			system, err3 := strconv.ParseUint(fields[3], 10, 64)
			idle, err4 := strconv.ParseUint(fields[4], 10, 64)
			if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
				return cpuCounters{}, errors.New("malformed required cpu counters")
			}
			var iowait, irq, softirq, steal uint64
			if len(fields) > 5 {
				iowait, _ = strconv.ParseUint(fields[5], 10, 64)
			}
			if len(fields) > 6 {
				irq, _ = strconv.ParseUint(fields[6], 10, 64)
			}
			if len(fields) > 7 {
				softirq, _ = strconv.ParseUint(fields[7], 10, 64)
			}
			if len(fields) > 8 {
				steal, _ = strconv.ParseUint(fields[8], 10, 64)
			}

			totalTicks := user + nice + system + idle + iowait + irq + softirq + steal
			idleTicks := idle + iowait
			return cpuCounters{Total: totalTicks, Idle: idleTicks}, nil
		}
	}
	return cpuCounters{}, errors.New("missing aggregate cpu line in /proc/stat")
}

// ParseHexPort extracts integer port from "IP:PORT" hex address string in /proc/net/tcp.
func ParseHexPort(addr string) int {
	parts := strings.Split(addr, ":")
	if len(parts) != 2 {
		return 0
	}
	val, err := strconv.ParseUint(parts[1], 16, 32)
	if err != nil {
		return 0
	}
	return int(val)
}

// ParseTCPTable parses a /proc/net/tcp table stream, attributing established and listening sockets
// strictly by managed local ports.
func ParseTCPTable(data []byte, managedMap map[int]bool, listeningMap map[int]bool) (int, error) {
	activeConns := 0
	scanner := bufio.NewScanner(bytes.NewReader(data))
	if !scanner.Scan() {
		return 0, errors.New("empty tcp table")
	}
	// header skipped
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 {
			continue
		}
		localAddr := fields[1]
		state := fields[3]

		port := ParseHexPort(localAddr)
		if port > 0 && managedMap[port] {
			switch state {
			case "01": // TCP_ESTABLISHED
				activeConns++
			case "0A": // TCP_LISTEN
				if listeningMap != nil {
					listeningMap[port] = true
				}
			}
		}
	}
	return activeConns, scanner.Err()
}

// WinDynamicResult represents the structured output of Windows dynamic PowerShell sampling.
type WinDynamicResult struct {
	ActiveConns    *int    `json:"Active"`
	ListeningCount *int    `json:"Listening"`
	TcpError       *string `json:"TcpError"`
	SvcStatus      *string `json:"SvcStatus"`
	ProcCount      *int    `json:"ProcCount"`
	NetInterface   *string `json:"NetInterface"`
	NetRxBytes     *uint64 `json:"NetRxBytes"`
	NetTxBytes     *uint64 `json:"NetTxBytes"`
	NetError       *string `json:"NetError"`
}

// ParseWindowsDynamic parses the Windows dynamic JSON payload and extracts verified metrics,
// preserving nil counts and unknown service state on probe failures.
func ParseWindowsDynamic(data []byte) (active *int, listening *int, state string, stateErr *string, netIf *string, netScope string, rxBytes *uint64, txBytes *uint64, unavail map[string]string) {
	unavail = make(map[string]string)
	var res WinDynamicResult
	if err := json.Unmarshal(data, &res); err != nil {
		addUnavailable(unavail, "windows_dynamic_json", err.Error())
		errStr := err.Error()
		return nil, nil, "unknown", &errStr, nil, "unknown", nil, nil, unavail
	}

	active = res.ActiveConns
	listening = res.ListeningCount
	if active == nil && res.TcpError != nil {
		addUnavailable(unavail, "activeConnections", *res.TcpError)
	}
	if listening == nil && res.TcpError != nil {
		addUnavailable(unavail, "listeningEndpoints", *res.TcpError)
	}

	// Determine 3proxy state from inspected service and process evidence
	if (res.ProcCount != nil && *res.ProcCount > 0) || (res.SvcStatus != nil && strings.EqualFold(*res.SvcStatus, "Running")) {
		state = "running"
	} else if (res.ProcCount != nil && *res.ProcCount == 0) && (res.SvcStatus != nil && !strings.EqualFold(*res.SvcStatus, "Running")) {
		state = "stopped"
	} else if res.ProcCount != nil && *res.ProcCount == 0 && res.SvcStatus == nil {
		state = "stopped"
	} else {
		state = "unknown"
		msg := "unable to determine 3proxy service/process state"
		stateErr = &msg
	}

	if res.NetInterface != nil && *res.NetInterface != "" {
		netIf = res.NetInterface
		rxBytes = res.NetRxBytes
		txBytes = res.NetTxBytes
		lower := strings.ToLower(*res.NetInterface)
		if strings.Contains(lower, "wireguard") || strings.Contains(lower, "proxyfleet") {
			netScope = "overlay"
		} else if strings.Contains(lower, "ethernet") || strings.Contains(lower, "wi-fi") || strings.Contains(lower, "vethernet") {
			netScope = "egress"
		} else {
			netScope = "unknown"
		}
	} else {
		netScope = "unknown"
		if res.NetError != nil {
			addUnavailable(unavail, "network", *res.NetError)
		}
	}

	return active, listening, state, stateErr, netIf, netScope, rxBytes, txBytes, unavail
}
