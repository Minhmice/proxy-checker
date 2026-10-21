//go:build windows

package device

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

type winCIMResult struct {
	Caption       string `json:"Caption"`
	Version       string `json:"Version"`
	TotalMemoryKB uint64 `json:"TotalMemoryKB"`
	OSArch        string `json:"OSArch"`
	Manufacturer  string `json:"Manufacturer"`
	Model         string `json:"Model"`
	LogicalCPUs   int    `json:"LogicalCPUs"`
	Hypervisor    *bool  `json:"Hypervisor"`
	CPUName       string `json:"CPUName"`
}

func detectPlatform(info *Info) {
	info.OSFamily = "windows"

	if host, err := os.Hostname(); err == nil && host != "" {
		info.Hostname = host
	} else {
		info.Hostname = "unknown"
		addSource(info.Sources, "hostname_err", "cannot resolve hostname")
	}

	detectWindowsArch(info)
	detectWindowsCIM(info)
}

func detectWindowsArch(info *Info) {
	arch := ResolveWindowsArch(
		os.Getenv("PROCESSOR_ARCHITECTURE"),
		os.Getenv("PROCESSOR_ARCHITEW6432"),
		"",
	)
	if arch != nil {
		info.OSArch = arch
		if os.Getenv("PROCESSOR_ARCHITEW6432") != "" {
			addSource(info.Sources, "osArch", "PROCESSOR_ARCHITEW6432")
		} else {
			addSource(info.Sources, "osArch", "PROCESSOR_ARCHITECTURE")
		}
	}
}

func detectWindowsCIM(info *Info) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	psScript := `$ErrorActionPreference='SilentlyContinue';` +
		`$os=Get-CimInstance Win32_OperatingSystem;` +
		`$cs=Get-CimInstance Win32_ComputerSystem;` +
		`$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1;` +
		`[PSCustomObject]@{` +
		`Caption=$os.Caption;Version=$os.Version;TotalMemoryKB=$os.TotalVisibleMemorySize;` +
		`OSArch=$os.OSArchitecture;Manufacturer=$cs.Manufacturer;Model=$cs.Model;` +
		`LogicalCPUs=$cs.NumberOfLogicalProcessors;Hypervisor=$cs.HypervisorPresent;` +
		`CPUName=$cpu.Name` +
		`}|ConvertTo-Json -Compress`

	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", psScript)
	out, err := cmd.Output()
	if err != nil {
		addSource(info.Sources, "cim_err", err.Error())
		fallbackStaticWindows(info)
		return
	}

	var res winCIMResult
	if err := json.Unmarshal(out, &res); err != nil {
		addSource(info.Sources, "cim_parse_err", err.Error())
		fallbackStaticWindows(info)
		return
	}

	addSource(info.Sources, "cim", "Get-CimInstance")

	if res.Caption != "" || res.Version != "" {
		v := strings.TrimSpace(res.Caption + " " + res.Version)
		info.OSVersion = &v
		if res.Version != "" {
			k := res.Version
			info.Kernel = &k
		}
	}

	if res.OSArch != "" {
		resolved := ResolveWindowsArch(
			os.Getenv("PROCESSOR_ARCHITECTURE"),
			os.Getenv("PROCESSOR_ARCHITEW6432"),
			res.OSArch,
		)
		if resolved != nil {
			info.OSArch = resolved
			addSource(info.Sources, "osArch", "Win32_OperatingSystem.OSArchitecture")
		}
	}

	if res.Manufacturer != "" {
		clean := CleanDMI(res.Manufacturer)
		if clean != "" {
			info.Vendor = &clean
		}
	}

	if res.Model != "" {
		clean := CleanDMI(res.Model)
		if clean != "" {
			info.Model = &clean
		}
	}

	if res.LogicalCPUs > 0 {
		cpus := res.LogicalCPUs
		info.LogicalCPUs = &cpus
	}

	if res.TotalMemoryKB > 0 {
		total := res.TotalMemoryKB * 1024
		info.MemoryTotalBytes = &total
	}

	if res.CPUName != "" {
		cpu := strings.TrimSpace(res.CPUName)
		info.CPUModel = &cpu
	}

	hypPresent := res.Hypervisor != nil && *res.Hypervisor
	vendorStr := ""
	if info.Vendor != nil {
		vendorStr = *info.Vendor
	}
	modelStr := ""
	if info.Model != nil {
		modelStr = *info.Model
	}
	if virt := ResolveVirtualization(vendorStr, modelStr, hypPresent); virt != nil {
		info.Virtualization = virt
		addSource(info.Sources, "virtualization", "vendor_model_evidence")
	}
}

func fallbackStaticWindows(info *Info) {
	numCPU := runtime.NumCPU()
	if numCPU > 0 {
		info.LogicalCPUs = &numCPU
		addSource(info.Sources, "logicalCpus", "runtime.NumCPU")
	}
	if cpuId := os.Getenv("PROCESSOR_IDENTIFIER"); cpuId != "" {
		info.CPUModel = &cpuId
		addSource(info.Sources, "cpuModel", "PROCESSOR_IDENTIFIER")
	}
}
