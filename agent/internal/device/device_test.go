package device

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPiModelNullTerminatorStripping(t *testing.T) {
	raw := []byte("Raspberry Pi 3 Model B Rev 1.2\x00\n")
	model, vendor := ParseDeviceTreeModel(raw)
	expectedModel := "Raspberry Pi 3 Model B Rev 1.2"
	expectedVendor := "Raspberry Pi Foundation"

	if model == nil || *model != expectedModel {
		t.Fatalf("expected model %q, got %v", expectedModel, model)
	}
	if vendor == nil || *vendor != expectedVendor {
		t.Fatalf("expected vendor %q, got %v", expectedVendor, vendor)
	}

	// Non-Pi device tree
	nonPi := []byte("Custom Board XYZ\x00")
	npModel, npVendor := ParseDeviceTreeModel(nonPi)
	if npModel == nil || *npModel != "Custom Board XYZ" {
		t.Fatalf("expected model Custom Board XYZ, got %v", npModel)
	}
	if npVendor != nil {
		t.Fatalf("expected nil vendor for custom board, got %v", npVendor)
	}
}

func TestCleanDMI(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"None", ""},
		{"Default string", ""},
		{"To be filled by O.E.M.", ""},
		{"System manufacturer", ""},
		{"System Product Name", ""},
		{"  ", ""},
		{"Dell Inc.", "Dell Inc."},
		{"OptiPlex 7090", "OptiPlex 7090"},
	}

	for _, c := range cases {
		got := CleanDMI(c.input)
		if got != c.expected {
			t.Errorf("CleanDMI(%q) = %q; want %q", c.input, got, c.expected)
		}
	}
}

func TestOSReleaseParsing(t *testing.T) {
	fixture := []byte(`# Test os-release
PRETTY_NAME="Ubuntu 22.04.4 LTS"
NAME="Ubuntu"
VERSION_ID="22.04"
VERSION="22.04.4 LTS (Jammy Jellyfish)"
ID=ubuntu
`)
	osVer, kv := ParseOSRelease(fixture)
	if osVer == nil || *osVer != "Ubuntu 22.04.4 LTS" {
		t.Errorf("expected pretty name Ubuntu 22.04.4 LTS, got %v", osVer)
	}
	if kv["NAME"] != "Ubuntu" {
		t.Errorf("expected name Ubuntu, got %q", kv["NAME"])
	}
	if kv["VERSION_ID"] != "22.04" {
		t.Errorf("expected version ID 22.04, got %q", kv["VERSION_ID"])
	}
}

func TestResolveWindowsArch(t *testing.T) {
	cases := []struct {
		procArch string
		arch64   string
		cimArch  string
		expected string
	}{
		// 1. 32-bit WOW64 agent on 64-bit AMD64 Windows
		{"x86", "AMD64", "", "amd64"},
		// 2. 32-bit WOW64 agent on ARM64 Windows
		{"x86", "ARM64", "", "arm64"},
		// 3. Native 64-bit agent on AMD64 Windows
		{"AMD64", "", "", "amd64"},
		// 4. Native 32-bit agent on 32-bit Windows with CIM confirmation
		{"x86", "", "32-bit", "386"},
		// 5. CIM OSArchitecture overrides ambiguous process arch
		{"x86", "", "64-bit", "amd64"},
		{"x86", "", "ARM 64-bit Processor", "arm64"},
	}

	for _, c := range cases {
		got := ResolveWindowsArch(c.procArch, c.arch64, c.cimArch)
		if got == nil || *got != c.expected {
			t.Errorf("ResolveWindowsArch(%q, %q, %q) = %v; want %q",
				c.procArch, c.arch64, c.cimArch, got, c.expected)
		}
	}

	// Unknown returns nil
	if v := ResolveWindowsArch("", "", ""); v != nil {
		t.Errorf("expected nil for empty arch strings, got %v", v)
	}
}

func TestResolveVirtualization(t *testing.T) {
	strPtr := func(s string) *string { return &s }
	cases := []struct {
		vendor   string
		model    string
		hyp      bool
		expected *string
	}{
		// Physical PC with VBS / Hyper-V role enabled: MUST BE NIL
		{"Dell Inc.", "OptiPlex 7090", true, nil},
		{"HP", "EliteBook 840 G8", true, nil},
		{"Lenovo", "ThinkPad T14 Gen 2", true, nil},
		{"ASUSTeK COMPUTER INC.", "PRIME Z690-P", true, nil},

		// Actual VMs:
		{"Microsoft Corporation", "Virtual Machine", true, strPtr("hyper-v")},
		{"VMware, Inc.", "VMware Virtual Platform", true, strPtr("vmware")},
		{"innotek GmbH", "VirtualBox", true, strPtr("virtualbox")},
		{"QEMU", "Standard PC (Q35 + ICH9, 2009)", true, strPtr("qemu")},
		{"Amazon EC2", "t3.medium", false, strPtr("amazon-ec2")},
		{"Xen", "HVM domU", true, strPtr("xen")},
	}

	for _, c := range cases {
		got := ResolveVirtualization(c.vendor, c.model, c.hyp)
		if c.expected == nil {
			if got != nil {
				t.Errorf("ResolveVirtualization(%q, %q, %v) = %q; want nil",
					c.vendor, c.model, c.hyp, *got)
			}
		} else {
			if got == nil || *got != *c.expected {
				t.Errorf("ResolveVirtualization(%q, %q, %v) = %v; want %q",
					c.vendor, c.model, c.hyp, got, *c.expected)
			}
		}
	}
}

func TestSourceSanitizationAndBounds(t *testing.T) {
	sources := make(map[string]string)

	longStr := strings.Repeat("a", 300)
	addSource(sources, "long_key", longStr)
	if len(sources["long_key"]) != 256 {
		t.Errorf("expected source value capped at 256, got length %d", len(sources["long_key"]))
	}

	ctrlStr := "hello\x00\x07world\n"
	sanitized := sanitizeSource(ctrlStr)
	if strings.Contains(sanitized, "\x00") || strings.Contains(sanitized, "\x07") {
		t.Errorf("expected control characters stripped, got %q", sanitized)
	}

	for i := range 50 {
		key := string(rune('A'+(i/26))) + string(rune('a'+(i%26)))
		addSource(sources, key, "val")
	}
	if len(sources) > 32 {
		t.Errorf("expected sources capped at 32 items, got %d", len(sources))
	}
}

func TestJSONWireContract(t *testing.T) {
	osVer := "Debian 12"
	kernel := "6.1.0-rpi"
	osArch := "aarch64"
	model := "Raspberry Pi 4 Model B"
	vendor := "Raspberry Pi Foundation"
	cpuModel := "Cortex-A72"
	cpus := 4
	totalMem := uint64(4140000000)

	info := Info{
		SchemaVersion:    1,
		Hostname:         "pi-worker-01",
		OSFamily:         "linux",
		OSVersion:        &osVer,
		Kernel:           &kernel,
		OSArch:           &osArch,
		AgentArch:        "arm64",
		Model:            &model,
		Vendor:           &vendor,
		CPUModel:         &cpuModel,
		LogicalCPUs:      &cpus,
		MemoryTotalBytes: &totalMem,
		Virtualization:   nil,
		Sources: map[string]string{
			"model": "/proc/device-tree/model",
		},
	}

	data, err := json.Marshal(info)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}

	requiredFields := []string{
		"schemaVersion", "hostname", "osFamily", "osVersion", "kernel",
		"osArch", "agentArch", "model", "vendor", "cpuModel",
		"logicalCpus", "memoryTotalBytes", "virtualization", "sources",
	}

	for _, f := range requiredFields {
		if _, ok := parsed[f]; !ok {
			t.Errorf("missing expected JSON field: %s", f)
		}
	}

	if parsed["virtualization"] != nil {
		t.Errorf("expected virtualization to be null, got %v", parsed["virtualization"])
	}

	rawStr := string(data)
	forbidden := []string{"serial", "mac", "uuid", "machineId"}
	for _, term := range forbidden {
		if strings.Contains(strings.ToLower(rawStr), term) {
			t.Errorf("found forbidden identifier %q in serialized device info", term)
		}
	}
}
