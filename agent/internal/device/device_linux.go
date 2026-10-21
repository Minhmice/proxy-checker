//go:build linux

package device

import (
	"bufio"
	"bytes"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func detectPlatform(info *Info) {
	info.OSFamily = "linux"

	if host, err := os.Hostname(); err == nil && host != "" {
		info.Hostname = host
	} else {
		info.Hostname = "unknown"
		addSource(info.Sources, "hostname_err", "cannot resolve hostname")
	}

	detectKernelAndArch(info)
	detectOSRelease(info)
	detectHardware(info)
	detectCPU(info)
	detectMemory(info)
}

func detectKernelAndArch(info *Info) {
	var uts syscall.Utsname
	if err := syscall.Uname(&uts); err == nil {
		kernel := charsToString(uts.Release[:])
		if kernel != "" {
			info.Kernel = &kernel
			addSource(info.Sources, "kernel", "syscall.Uname")
		}
		osArch := charsToString(uts.Machine[:])
		if osArch != "" {
			info.OSArch = &osArch
			addSource(info.Sources, "osArch", "syscall.Uname")
		}
	} else {
		addSource(info.Sources, "uname_err", err.Error())
	}
}

func charsToString[T ~int8 | ~uint8](ca []T) string {
	buf := make([]byte, 0, len(ca))
	for _, c := range ca {
		if c == 0 {
			break
		}
		buf = append(buf, byte(c))
	}
	return strings.TrimSpace(string(buf))
}

func detectOSRelease(info *Info) {
	paths := []string{"/etc/os-release", "/usr/lib/os-release"}
	var content []byte
	var foundPath string
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err == nil {
			content = data
			foundPath = p
			break
		}
	}

	if len(content) == 0 {
		addSource(info.Sources, "os_release", "not found")
		return
	}

	addSource(info.Sources, "os_release_file", foundPath)
	osVer, _ := ParseOSRelease(content)
	info.OSVersion = osVer
}


func detectHardware(info *Info) {
	// 1. Device tree model (Raspberry Pi & SBCs)
	dtPaths := []string{"/proc/device-tree/model", "/sys/firmware/devicetree/base/model"}
	for _, p := range dtPaths {
		data, err := os.ReadFile(p)
		if err == nil {
			model, vendor := ParseDeviceTreeModel(data)
			if model != nil {
				info.Model = model
				addSource(info.Sources, "model", p)
				if vendor != nil {
					info.Vendor = vendor
					addSource(info.Sources, "vendor", "device_tree_heuristic")
				}
				break
			}
		}
	}

	// 2. DMI identification (PC/Server/VM)
	if info.Model == nil {
		if prodData, err := os.ReadFile("/sys/class/dmi/id/product_name"); err == nil {
			prod := CleanDMI(string(prodData))
			if prod != "" {
				info.Model = &prod
				addSource(info.Sources, "model", "/sys/class/dmi/id/product_name")
			}
		}
	}

	if info.Vendor == nil {
		if vendorData, err := os.ReadFile("/sys/class/dmi/id/sys_vendor"); err == nil {
			vend := CleanDMI(string(vendorData))
			if vend != "" {
				info.Vendor = &vend
				addSource(info.Sources, "vendor", "/sys/class/dmi/id/sys_vendor")
			}
		}
	}

	// Detect virtualization
	detectVirtualization(info)
}


func detectVirtualization(info *Info) {
	if hyp, err := os.ReadFile("/sys/hypervisor/type"); err == nil {
		h := strings.TrimSpace(string(hyp))
		if h != "" {
			info.Virtualization = &h
			addSource(info.Sources, "virtualization", "/sys/hypervisor/type")
			return
		}
	}

	vendorStr := ""
	if info.Vendor != nil {
		vendorStr = *info.Vendor
	}
	modelStr := ""
	if info.Model != nil {
		modelStr = *info.Model
	}
	if virt := ResolveVirtualization(vendorStr, modelStr, false); virt != nil {
		info.Virtualization = virt
		addSource(info.Sources, "virtualization", "dmi_heuristic")
	}
}

func detectCPU(info *Info) {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		addSource(info.Sources, "cpu_err", err.Error())
		return
	}

	cores := 0
	var cpuModel string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "processor") && strings.Contains(line, ":") {
			cores++
		} else if cpuModel == "" {
			if strings.HasPrefix(line, "model name") && strings.Contains(line, ":") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					cpuModel = strings.TrimSpace(parts[1])
				}
			} else if strings.HasPrefix(line, "Hardware") && strings.Contains(line, ":") {
				// ARM/Pi fallback
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					cpuModel = strings.TrimSpace(parts[1])
				}
			}
		}
	}

	if cores > 0 {
		info.LogicalCPUs = &cores
		addSource(info.Sources, "logicalCpus", "/proc/cpuinfo")
	}
	if cpuModel != "" {
		info.CPUModel = &cpuModel
		addSource(info.Sources, "cpuModel", "/proc/cpuinfo")
	}
}

func detectMemory(info *Info) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		addSource(info.Sources, "mem_err", err.Error())
		return
	}

	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if kb, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
					total := kb * 1024
					info.MemoryTotalBytes = &total
					addSource(info.Sources, "memoryTotalBytes", "/proc/meminfo")
				}
			}
			break
		}
	}
}
