package device

import (
	"runtime"
	"strings"
	"unicode"
)

// Info matches FleetDeviceInfo wire contract.
type Info struct {
	SchemaVersion    int               `json:"schemaVersion"`
	Hostname         string            `json:"hostname"`
	OSFamily         string            `json:"osFamily"`
	OSVersion        *string           `json:"osVersion"`
	Kernel           *string           `json:"kernel"`
	OSArch           *string           `json:"osArch"`
	AgentArch        string            `json:"agentArch"`
	Model            *string           `json:"model"`
	Vendor           *string           `json:"vendor"`
	CPUModel         *string           `json:"cpuModel"`
	LogicalCPUs      *int              `json:"logicalCpus"`
	MemoryTotalBytes *uint64           `json:"memoryTotalBytes"`
	Virtualization   *string           `json:"virtualization"`
	Sources          map[string]string `json:"sources"`
}

// Detect gathers static device information for the current host.
// Static queries run once at startup.
func Detect() Info {
	info := Info{
		SchemaVersion: 1,
		AgentArch:     runtime.GOARCH,
		Sources:       make(map[string]string),
	}
	detectPlatform(&info)
	return info
}

// sanitizeSource ensures source values are printable and <= 256 chars.
func sanitizeSource(val string) string {
	var sb strings.Builder
	for _, r := range val {
		if r == '\n' || r == '\r' || r == '\t' || (r >= 32 && r != 127) {
			if unicode.IsPrint(r) || r == ' ' {
				sb.WriteRune(r)
			}
		}
	}
	res := strings.TrimSpace(sb.String())
	if len(res) > 256 {
		return res[:256]
	}
	return res
}

// addSource adds an entry to sources map, capped at 32 entries.
func addSource(sources map[string]string, key, val string) {
	if len(sources) >= 32 {
		return
	}
	if len(key) > 64 {
		key = key[:64]
	}
	sources[key] = sanitizeSource(val)
}

func stringPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func intPtr(i int) *int {
	return &i
}

func uint64Ptr(u uint64) *uint64 {
	return &u
}

// ParseDeviceTreeModel strips null-terminators and whitespace, returning sanitized model and vendor.
func ParseDeviceTreeModel(data []byte) (*string, *string) {
	trimmed := strings.Trim(string(data), "\x00\r\n \t")
	if trimmed == "" {
		return nil, nil
	}
	model := trimmed
	var vendor *string
	if strings.Contains(strings.ToLower(trimmed), "raspberry pi") {
		v := "Raspberry Pi Foundation"
		vendor = &v
	}
	return &model, vendor
}

// ParseOSRelease parses key-value pairs from os-release format and returns resolved OSVersion and full kv map.
func ParseOSRelease(content []byte) (*string, map[string]string) {
	kv := make(map[string]string)
	for _, rawLine := range strings.Split(string(content), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			k := strings.TrimSpace(parts[0])
			v := strings.Trim(strings.TrimSpace(parts[1]), "\"'")
			kv[k] = v
		}
	}

	var osVersion *string
	if pretty, ok := kv["PRETTY_NAME"]; ok && pretty != "" {
		osVersion = &pretty
	} else if name, ok := kv["NAME"]; ok && name != "" {
		if ver, ok := kv["VERSION"]; ok && ver != "" {
			v := name + " " + ver
			osVersion = &v
		} else {
			osVersion = &name
		}
	}
	return osVersion, kv
}

// CleanDMI trims and removes default dummy strings from vendor or product names.
func CleanDMI(s string) string {
	trimmed := strings.TrimSpace(s)
	lower := strings.ToLower(trimmed)
	if lower == "" || lower == "none" || lower == "default string" ||
		lower == "to be filled by o.e.m." || lower == "system manufacturer" ||
		lower == "system product name" {
		return ""
	}
	return trimmed
}

// ResolveWindowsArch resolves native operating system architecture, accounting for WOW64.
func ResolveWindowsArch(procArch, arch64, cimArch string) *string {
	// 1. WOW64 environment variable indicates 32-bit process on 64-bit OS
	if a64 := strings.ToLower(strings.TrimSpace(arch64)); a64 != "" {
		switch a64 {
		case "amd64":
			res := "amd64"
			return &res
		case "arm64":
			res := "arm64"
			return &res
		}
	}

	// 2. CIM OSArchitecture resolution
	if cim := strings.ToLower(strings.TrimSpace(cimArch)); cim != "" {
		if strings.Contains(cim, "arm") && strings.Contains(cim, "64") {
			res := "arm64"
			return &res
		}
		if strings.Contains(cim, "64") || strings.Contains(cim, "amd64") {
			res := "amd64"
			return &res
		}
		if strings.Contains(cim, "32") || strings.Contains(cim, "x86") {
			res := "386"
			return &res
		}
	}

	// 3. Fallback to PROCESSOR_ARCHITECTURE
	p := strings.ToLower(strings.TrimSpace(procArch))
	switch p {
	case "amd64":
		res := "amd64"
		return &res
	case "arm64":
		res := "arm64"
		return &res
	case "x86":
		res := "386"
		return &res
	default:
		if p != "" {
			return &p
		}
	}
	return nil
}

// ResolveVirtualization identifies guest hypervisor only from specific VM evidence,
// ignoring HypervisorPresent alone which is true on physical Windows hosts with VBS.
func ResolveVirtualization(vendor, model string, hypervisorPresent bool) *string {
	combined := strings.ToLower(vendor + " " + model)
	switch {
	case strings.Contains(combined, "qemu"):
		v := "qemu"
		return &v
	case strings.Contains(combined, "kvm"):
		v := "kvm"
		return &v
	case strings.Contains(combined, "vmware"):
		v := "vmware"
		return &v
	case strings.Contains(combined, "virtualbox"):
		v := "virtualbox"
		return &v
	case strings.Contains(combined, "amazon ec2"):
		v := "amazon-ec2"
		return &v
	case strings.Contains(combined, "xen"):
		v := "xen"
		return &v
	case strings.Contains(combined, "parallels"):
		v := "parallels"
		return &v
	case strings.Contains(combined, "bochs"):
		v := "bochs"
		return &v
	case strings.Contains(combined, "microsoft corporation") &&
		(strings.Contains(combined, "virtual machine") || strings.Contains(combined, "virtual") || strings.Contains(combined, "hyper-v")):
		v := "hyper-v"
		return &v
	}

	// Even if hypervisorPresent == true, physical PC with VBS/Hyper-V is not a guest VM.
	return nil
}
