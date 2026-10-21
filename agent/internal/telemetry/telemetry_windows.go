//go:build windows

package telemetry

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	modKernel32            = syscall.NewLazyDLL("kernel32.dll")
	procGetTickCount64     = modKernel32.NewProc("GetTickCount64")
	procGlobalMemoryStatus = modKernel32.NewProc("GlobalMemoryStatusEx")
	procGetSystemTimes     = modKernel32.NewProc("GetSystemTimes")
)

type memoryStatusEx struct {
	cbSize                  uint32
	dwMemoryLoad            uint32
	ullTotalPhys            uint64
	ullAvailPhys            uint64
	ullTotalPageFile        uint64
	ullAvailPageFile        uint64
	ullTotalVirtual         uint64
	ullAvailVirtual         uint64
	ullAvailExtendedVirtual uint64
}

type fileTime struct {
	dwLowDateTime  uint32
	dwHighDateTime uint32
}

func (ft *fileTime) toUint64() uint64 {
	return (uint64(ft.dwHighDateTime) << 32) | uint64(ft.dwLowDateTime)
}

func (c *Collector) samplePlatform(ctx context.Context, managedPorts []int, snap *Snapshot) {
	c.sampleWindowsUptime(snap)
	c.sampleWindowsMemory(snap)
	c.sampleWindowsCPU(snap)
	c.sampleWindowsDynamic(ctx, managedPorts, snap)
}

func (c *Collector) sampleWindowsUptime(snap *Snapshot) {
	if procGetTickCount64.Find() == nil {
		r1, _, _ := procGetTickCount64.Call()
		if r1 > 0 {
			secs := uint64(r1 / 1000)
			snap.UptimeSeconds = &secs
			return
		}
	}
	addUnavailable(snap.Unavailable, "uptimeSeconds", "GetTickCount64 unavailable")
}

func (c *Collector) sampleWindowsMemory(snap *Snapshot) {
	if procGlobalMemoryStatus.Find() == nil {
		var mem memoryStatusEx
		mem.cbSize = uint32(unsafe.Sizeof(mem))
		r1, _, err := procGlobalMemoryStatus.Call(uintptr(unsafe.Pointer(&mem)))
		if r1 != 0 {
			snap.MemoryTotalBytes = &mem.ullTotalPhys
			snap.MemoryAvailableBytes = &mem.ullAvailPhys
			return
		}
		addUnavailable(snap.Unavailable, "memory", err.Error())
		return
	}
	addUnavailable(snap.Unavailable, "memory", "GlobalMemoryStatusEx unavailable")
}

func (c *Collector) sampleWindowsCPU(snap *Snapshot) {
	if procGetSystemTimes.Find() == nil {
		var idleTime, kernelTime, userTime fileTime
		r1, _, err := procGetSystemTimes.Call(
			uintptr(unsafe.Pointer(&idleTime)),
			uintptr(unsafe.Pointer(&kernelTime)),
			uintptr(unsafe.Pointer(&userTime)),
		)
		if r1 != 0 {
			idle := idleTime.toUint64()
			kernel := kernelTime.toUint64()
			user := userTime.toUint64()

			// On Windows, kernelTime includes idleTime
			total := kernel + user

			curr := cpuCounters{Total: total, Idle: idle}
			if c.prevCPU != nil {
				snap.CPUPercent = cpuPercent(*c.prevCPU, curr)
			}
			c.prevCPU = &curr
			return
		}
		addUnavailable(snap.Unavailable, "cpuPercent", err.Error())
		return
	}
	addUnavailable(snap.Unavailable, "cpuPercent", "GetSystemTimes unavailable")
}

func (c *Collector) sampleWindowsDynamic(ctx context.Context, managedPorts []int, snap *Snapshot) {
	now := time.Now().UnixMilli()
	snap.Proxy.CheckedAt = &now

	// Bounded context timeout (max 3 seconds)
	cmdCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	portStrings := make([]string, 0, len(managedPorts))
	for _, p := range managedPorts {
		if p > 0 && p <= 65535 {
			portStrings = append(portStrings, strconv.Itoa(p))
		}
	}
	portArrayLit := "@(" + strings.Join(portStrings, ",") + ")"

	psScript := `$ports=` + portArrayLit + `;` +
		`$active=$null;$listening=$null;$tcpErr=$null;` +
		`try{` +
		`  $conns=Get-NetTCPConnection -State Established -ErrorAction Stop|Where-Object{$ports -contains $_.LocalPort};` +
		`  $active=@($conns).Count;` +
		`}catch{$tcpErr=$_.Exception.Message};` +
		`try{` +
		`  $listen=Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object{$ports -contains $_.LocalPort};` +
		`  $uniquePorts=@($listen|Select-Object -ExpandProperty LocalPort -Unique);` +
		`  $listening=$uniquePorts.Count;` +
		`}catch{if(!$tcpErr){$tcpErr=$_.Exception.Message}};` +
		`$svcStatus=$null;try{$svc=Get-Service -Name 3proxy -ErrorAction Stop;$svcStatus=$svc.Status.ToString()}catch{};` +
		`$procCount=$null;try{$procs=Get-Process -Name 3proxy -ErrorAction Stop;$procCount=@($procs).Count}catch{};` +
		`$netIf=$null;$netRx=$null;$netTx=$null;$netErr=$null;` +
		`try{` +
		`  $route=Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop|Select-Object -First 1;` +
		`  if($route){` +
		`    $stat=Get-NetAdapterStatistics -Name $route.InterfaceAlias -ErrorAction Stop|Select-Object -First 1;` +
		`    if($stat){$netIf=$stat.Name;$netRx=$stat.ReceivedBytes;$netTx=$stat.SentBytes}` +
		`  }` +
		`}catch{$netErr=$_.Exception.Message};` +
		`[PSCustomObject]@{` +
		`Active=$active;Listening=$listening;TcpError=$tcpErr;` +
		`SvcStatus=$svcStatus;ProcCount=$procCount;` +
		`NetInterface=$netIf;NetRxBytes=$netRx;NetTxBytes=$netTx;NetError=$netErr` +
		`}|ConvertTo-Json -Compress`

	cmd := exec.CommandContext(cmdCtx, "powershell", "-NoProfile", "-NonInteractive", "-Command", psScript)
	out, err := cmd.Output()
	if err != nil {
		addUnavailable(snap.Unavailable, "windows_dynamic", err.Error())
		snap.Proxy.State = "unknown"
		errStr := err.Error()
		snap.Proxy.Error = &errStr
		return
	}

	active, listening, state, stateErr, netIf, netScope, rxBytes, txBytes, unavail := ParseWindowsDynamic(out)
	snap.Proxy.ActiveConnections = active
	snap.Proxy.ListeningEndpoints = listening
	snap.Proxy.State = state
	snap.Proxy.Error = stateErr
	for k, v := range unavail {
		addUnavailable(snap.Unavailable, k, v)
	}

	if netIf != nil {
		snap.Network.InterfaceName = netIf
		snap.Network.Scope = netScope
		snap.Network.RxBytes = rxBytes
		snap.Network.TxBytes = txBytes

		if rxBytes != nil && txBytes != nil {
			currNet := netCounters{
				RxBytes:   *rxBytes,
				TxBytes:   *txBytes,
				Timestamp: time.Now(),
				Interface: *netIf,
			}
			if c.prevNet != nil {
				snap.Network.RxBytesPerSecond, snap.Network.TxBytesPerSecond = calculateNetRates(*c.prevNet, currNet)
			}
			c.prevNet = &currNet
		}
	}
}
