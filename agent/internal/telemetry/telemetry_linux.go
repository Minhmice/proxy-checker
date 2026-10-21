//go:build linux

package telemetry

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"strconv"
	"strings"
	"time"
)

func (c *Collector) samplePlatform(ctx context.Context, managedPorts []int, snap *Snapshot) {
	c.sampleUptime(snap)
	c.sampleLoadAvg(snap)
	c.sampleMemory(snap)
	c.sampleCPU(snap)
	c.sampleNetwork(snap)
	c.sampleSocketsAndProxy(snap, managedPorts)
}

func (c *Collector) sampleUptime(snap *Snapshot) {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		addUnavailable(snap.Unavailable, "uptimeSeconds", err.Error())
		return
	}
	fields := strings.Fields(string(data))
	if len(fields) > 0 {
		if val, err := strconv.ParseFloat(fields[0], 64); err == nil && val >= 0 {
			secs := uint64(val)
			snap.UptimeSeconds = &secs
		}
	}
}

func (c *Collector) sampleLoadAvg(snap *Snapshot) {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		addUnavailable(snap.Unavailable, "loadAverage1m", err.Error())
		return
	}
	fields := strings.Fields(string(data))
	if len(fields) > 0 {
		if val, err := strconv.ParseFloat(fields[0], 64); err == nil && val >= 0 {
			snap.LoadAverage1m = &val
		}
	}
}

func (c *Collector) sampleMemory(snap *Snapshot) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		addUnavailable(snap.Unavailable, "memory", err.Error())
		return
	}

	var totalKB, availKB, freeKB, buffersKB, cachedKB uint64
	var hasAvail bool

	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		val, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			totalKB = val
		case "MemAvailable:":
			availKB = val
			hasAvail = true
		case "MemFree:":
			freeKB = val
		case "Buffers:":
			buffersKB = val
		case "Cached:":
			cachedKB = val
		}
	}

	if totalKB > 0 {
		total := totalKB * 1024
		snap.MemoryTotalBytes = &total
	}

	if hasAvail {
		avail := availKB * 1024
		snap.MemoryAvailableBytes = &avail
	} else if totalKB > 0 {
		// Fallback for older Linux kernels
		avail := (freeKB + buffersKB + cachedKB) * 1024
		if snap.MemoryTotalBytes != nil && avail > *snap.MemoryTotalBytes {
			avail = *snap.MemoryTotalBytes
		}
		snap.MemoryAvailableBytes = &avail
	}
}

func (c *Collector) sampleCPU(snap *Snapshot) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		addUnavailable(snap.Unavailable, "cpuPercent", err.Error())
		return
	}

	curr, err := ParseProcStat(data)
	if err != nil {
		addUnavailable(snap.Unavailable, "cpuPercent", err.Error())
		return
	}

	if c.prevCPU != nil {
		snap.CPUPercent = cpuPercent(*c.prevCPU, curr)
	}
	c.prevCPU = &curr
}

func (c *Collector) sampleNetwork(snap *Snapshot) {
	defaultIf := findDefaultRouteInterface()

	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		addUnavailable(snap.Unavailable, "network", err.Error())
		return
	}

	type ifStat struct {
		name    string
		rxBytes uint64
		txBytes uint64
	}

	var candidates []ifStat
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.Contains(line, ":") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		ifName := strings.TrimSpace(parts[0])
		if ifName == "lo" {
			continue
		}

		fields := strings.Fields(parts[1])
		if len(fields) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(fields[0], 10, 64)
		tx, err2 := strconv.ParseUint(fields[8], 10, 64)
		if err1 == nil && err2 == nil {
			candidates = append(candidates, ifStat{name: ifName, rxBytes: rx, txBytes: tx})
		}
	}

	if len(candidates) == 0 {
		return
	}

	// Pick default route interface, or one with highest traffic
	var chosen ifStat
	found := false
	if defaultIf != "" {
		for _, stat := range candidates {
			if stat.name == defaultIf {
				chosen = stat
				found = true
				break
			}
		}
	}
	if !found {
		var maxTraffic uint64
		for _, stat := range candidates {
			traffic := stat.rxBytes + stat.txBytes
			if traffic >= maxTraffic {
				maxTraffic = traffic
				chosen = stat
				found = true
			}
		}
	}

	if !found {
		chosen = candidates[0]
	}

	snap.Network.InterfaceName = &chosen.name
	snap.Network.RxBytes = &chosen.rxBytes
	snap.Network.TxBytes = &chosen.txBytes

	// Determine scope
	nameLower := strings.ToLower(chosen.name)
	if strings.HasPrefix(nameLower, "wg") || strings.HasPrefix(nameLower, "proxyfleet") {
		snap.Network.Scope = "overlay"
	} else if strings.HasPrefix(nameLower, "eth") || strings.HasPrefix(nameLower, "en") ||
		strings.HasPrefix(nameLower, "wl") || strings.HasPrefix(nameLower, "wlan") {
		snap.Network.Scope = "egress"
	} else {
		snap.Network.Scope = "unknown"
	}

	currNet := netCounters{
		RxBytes:   chosen.rxBytes,
		TxBytes:   chosen.txBytes,
		Timestamp: time.Now(),
		Interface: chosen.name,
	}

	if c.prevNet != nil {
		snap.Network.RxBytesPerSecond, snap.Network.TxBytesPerSecond = calculateNetRates(*c.prevNet, currNet)
	}
	c.prevNet = &currNet
}

func findDefaultRouteInterface() string {
	data, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return ""
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		// Col 0: Iface, Col 1: Destination (00000000 is default route)
		if len(fields) >= 2 && fields[1] == "00000000" {
			return fields[0]
		}
	}
	return ""
}

func (c *Collector) sampleSocketsAndProxy(snap *Snapshot, managedPorts []int) {
	now := time.Now().UnixMilli()
	snap.Proxy.CheckedAt = &now

	managedMap := make(map[int]bool, len(managedPorts))
	for _, p := range managedPorts {
		if p > 0 && p <= 65535 {
			managedMap[p] = true
		}
	}

	listeningMap := make(map[int]bool)
	activeTotal := 0
	socketReadFailed := false

	// Read IPv4 TCP table (required)
	data4, err4 := os.ReadFile("/proc/net/tcp")
	if err4 != nil {
		socketReadFailed = true
		addUnavailable(snap.Unavailable, "sockets", "failed to read /proc/net/tcp: "+err4.Error())
	} else {
		act4, errParse := ParseTCPTable(data4, managedMap, listeningMap)
		if errParse != nil {
			socketReadFailed = true
			addUnavailable(snap.Unavailable, "sockets", "failed to parse /proc/net/tcp: "+errParse.Error())
		} else {
			activeTotal += act4
		}
	}

	// Read IPv6 TCP table (if present)
	data6, err6 := os.ReadFile("/proc/net/tcp6")
	if err6 != nil {
		if !os.IsNotExist(err6) {
			socketReadFailed = true
			addUnavailable(snap.Unavailable, "sockets_ipv6", "failed to read /proc/net/tcp6: "+err6.Error())
		}
	} else {
		act6, errParse := ParseTCPTable(data6, managedMap, listeningMap)
		if errParse != nil {
			socketReadFailed = true
			addUnavailable(snap.Unavailable, "sockets_ipv6", "failed to parse /proc/net/tcp6: "+errParse.Error())
		} else {
			activeTotal += act6
		}
	}

	if !socketReadFailed {
		listeningCount := len(listeningMap)
		snap.Proxy.ListeningEndpoints = &listeningCount
		snap.Proxy.ActiveConnections = &activeTotal
	} else {
		snap.Proxy.ListeningEndpoints = nil
		snap.Proxy.ActiveConnections = nil
	}

	// Check 3proxy process state
	state, reason := check3ProxyProcess()
	snap.Proxy.State = state
	if reason != "" {
		snap.Proxy.Error = &reason
	}
}

func check3ProxyProcess() (string, string) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return "unknown", "failed to read /proc: " + err.Error()
	}

	hasPermissionDenied := false
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if len(name) == 0 || name[0] < '0' || name[0] > '9' {
			continue
		}

		commPath := "/proc/" + name + "/comm"
		comm, err := os.ReadFile(commPath)
		if err != nil {
			if os.IsPermission(err) {
				hasPermissionDenied = true
			}
			continue
		}
		if strings.TrimSpace(string(comm)) == "3proxy" {
			return "running", ""
		}
	}

	if hasPermissionDenied {
		return "unknown", "incomplete process visibility (/proc permission denied)"
	}
	return "stopped", ""
}
