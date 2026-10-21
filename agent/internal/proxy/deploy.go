package proxy

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type BudgetEvidence struct {
	SoftLimit uint64
	OpenFDs uint64
	ConfigPath string
	Verified bool
}

func ValidateCapacity(content, configPath string, evidence BudgetEvidence) error {
	maxconn, listeners, err := candidateCapacity(content)
	if err != nil || maxconn == 0 {
		return err
	}
	if !evidence.Verified || !samePath(configPath, evidence.ConfigPath) || evidence.SoftLimit == 0 {
		return fmt.Errorf("cannot verify 3proxy capacity budget for %s: service ownership or file descriptor limit unknown", configPath)
	}
	// Forwarding holds inbound and outbound sockets for each live client.
	perListener := uint64(maxconn)*2 + 1
	if uint64(listeners) > ^uint64(0)/perListener { return fmt.Errorf("capacity file descriptor requirement overflow") }
	capacityFDs := uint64(listeners) * perListener
	if capacityFDs > ^uint64(0)-evidence.OpenFDs { return fmt.Errorf("capacity file descriptor requirement overflow") }
	required := evidence.OpenFDs + capacityFDs
	if required > evidence.SoftLimit {
		return fmt.Errorf("capacity requires %d file descriptors including %d open, limit %d", required, evidence.OpenFDs, evidence.SoftLimit)
	}
	return nil
}

func candidateCapacity(content string) (int, int, error) {
	maxconn, listeners := 0, 0
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 { continue }
		switch fields[0] {
		case "maxconn":
			if len(fields) != 2 { return 0, 0, fmt.Errorf("invalid maxconn directive") }
			n, err := strconv.Atoi(fields[1])
			if err != nil || n <= 0 { return 0, 0, fmt.Errorf("invalid maxconn directive") }
			if n > maxconn { maxconn = n }
		case "proxy", "socks": listeners++
		}
	}
	if err := scanner.Err(); err != nil { return 0, 0, err }
	if maxconn > 0 && listeners == 0 { return 0, 0, fmt.Errorf("maxconn configured without listeners") }
	return maxconn, listeners, nil
}

func samePath(a, b string) bool {
	a, _ = filepath.Abs(a); b, _ = filepath.Abs(b)
	return filepath.Clean(a) == filepath.Clean(b)
}

func hasPathArgument(command, configPath string) bool {
	for _, arg := range strings.Fields(command) {
		arg = strings.Trim(arg, "\"'{};,[]")
		if _, value, ok := strings.Cut(arg, "="); ok { arg = strings.Trim(value, "\"'{};,[]") }
		if samePath(arg, configPath) { return true }
	}
	return false
}

func systemBudgetEvidence(service, configPath string) (BudgetEvidence, error) {
	if runtime.GOOS == "windows" { return BudgetEvidence{}, fmt.Errorf("capacity budget unsupported on Windows: no verified 3proxy file descriptor evidence") }
	if runtime.GOOS != "linux" { return BudgetEvidence{}, fmt.Errorf("capacity budget unsupported on %s", runtime.GOOS) }
	output, err := exec.Command("systemctl", "show", service, "--property=MainPID", "--property=LimitNOFILE", "--property=ExecStart").Output()
	if err != nil { return BudgetEvidence{}, fmt.Errorf("inspect 3proxy service: %w", err) }
	values := map[string]string{}
	for _, line := range strings.Split(string(output), "\n") { key, value, ok := strings.Cut(line, "="); if ok { values[key] = value } }
	if !hasPathArgument(values["ExecStart"], configPath) { return BudgetEvidence{}, fmt.Errorf("3proxy service does not own configured path %s", configPath) }
	limit, err := strconv.ParseUint(values["LimitNOFILE"], 10, 64)
	if err != nil || limit == 0 { return BudgetEvidence{}, fmt.Errorf("3proxy service file descriptor limit unknown") }
	e := BudgetEvidence{SoftLimit: limit, ConfigPath: configPath, Verified: true}
	pid, err := strconv.Atoi(values["MainPID"])
	if err != nil { return BudgetEvidence{}, fmt.Errorf("3proxy service MainPID unknown") }
	if pid == 0 { return e, nil }
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil || !hasPathArgument(strings.ReplaceAll(string(cmdline), "\x00", " "), configPath) { return BudgetEvidence{}, fmt.Errorf("3proxy MainPID does not match configured path %s", configPath) }
	limits, err := os.ReadFile(fmt.Sprintf("/proc/%d/limits", pid))
	if err != nil { return BudgetEvidence{}, fmt.Errorf("read 3proxy process limits: %w", err) }
	found := false
	for _, line := range strings.Split(string(limits), "\n") { if strings.HasPrefix(strings.TrimSpace(line), "Max open files") { fields := strings.Fields(line); if len(fields) < 4 { break }; e.SoftLimit, err = strconv.ParseUint(fields[3], 10, 64); found = err == nil; break } }
	if !found || e.SoftLimit == 0 { return BudgetEvidence{}, fmt.Errorf("3proxy process file descriptor limit unknown") }
	fds, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
	if err != nil { return BudgetEvidence{}, fmt.Errorf("count 3proxy open file descriptors: %w", err) }
	e.OpenFDs = uint64(len(fds))
	return e, nil
}

type Deployer struct {
	configPath string
	backupPath string
	reloadCmd string
	isCustomExec bool
	execCommand func(name string, arg ...string) error
}

func NewDeployer(configPath string) *Deployer {
	return &Deployer{
		configPath: configPath,
		backupPath: configPath + ".bak",
		reloadCmd:  "3proxy",
		execCommand: func(name string, arg ...string) error {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, name, arg...)
			return cmd.Run()
		},
	}
}

func (d *Deployer) SetExecCommand(fn func(name string, arg ...string) error) {
	d.execCommand = fn
	d.isCustomExec = true
}


func (d *Deployer) Apply(content string) error {
	maxconn, _, err := candidateCapacity(content)
	if err != nil { return fmt.Errorf("validate candidate capacity: %w", err) }
	if maxconn > 0 {
		evidence, err := systemBudgetEvidence(d.reloadCmd, d.configPath)
		if err != nil { return err }
		if err := ValidateCapacity(content, d.configPath, evidence); err != nil { return err }
	}
	dir := filepath.Dir(d.configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create config dir error: %w", err)
	}

	// 1. Backup existing config if exists
	hasExisting := false
	if existingBytes, err := os.ReadFile(d.configPath); err == nil {
		hasExisting = true
		if err := os.WriteFile(d.backupPath, existingBytes, 0600); err != nil {
			return fmt.Errorf("write backup error: %w", err)
		}
	}

	// 2. Write to temp file in same directory
	tempFile := d.configPath + ".tmp"
	if err := os.WriteFile(tempFile, []byte(content), 0600); err != nil {
		return fmt.Errorf("write temp config error: %w", err)
	}

	// 3. Atomic rename
	if err := os.Rename(tempFile, d.configPath); err != nil {
		os.Remove(tempFile)
		return fmt.Errorf("atomic rename error: %w", err)
	}

	// 4. Trigger service reload / restart
	if err := d.reloadService(); err != nil {
		// Rollback immediately and report any rollback failure
		rbErr := d.Rollback(hasExisting)
		if rbErr != nil {
			return fmt.Errorf("reload failed: %w (rollback error: %v)", err, rbErr)
		}
		return fmt.Errorf("reload failed, rolled back to previous config: %w", err)
	}
	return nil
}

func (d *Deployer) Rollback(hasExisting bool) error {
	if hasExisting {
		backupBytes, err := os.ReadFile(d.backupPath)
		if err != nil {
			return fmt.Errorf("read backup for rollback error: %w", err)
		}
		if err := os.WriteFile(d.configPath, backupBytes, 0600); err != nil {
			return fmt.Errorf("restore backup config error: %w", err)
		}
		if err := d.reloadService(); err != nil {
			return fmt.Errorf("reload after rollback error: %w", err)
		}
	} else {
		if err := os.Remove(d.configPath); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove config error: %w", err)
		}
		if err := d.reloadService(); err != nil {
			return fmt.Errorf("reload after rollback error: %w", err)
		}
	}
	return nil
}

func (d *Deployer) reloadService() error {
	if d.isCustomExec {
		if runtime.GOOS == "windows" {
			return d.execCommand("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Restart-Service -Name 3proxy -ErrorAction Stop")
		}
		return d.execCommand("systemctl", "reload-or-restart", d.reloadCmd)
	}
	if flag.Lookup("test.v") != nil {
		return nil
	}

	if runtime.GOOS == "windows" {
		if psPath, err := exec.LookPath("powershell.exe"); err == nil {
			return d.execCommand(psPath, "-NoProfile", "-NonInteractive", "-Command", "$svc = Get-Service -Name 3proxy -ErrorAction Stop; Restart-Service -InputObject $svc -ErrorAction Stop; $svc.Refresh(); if ($svc.Status -ne 'Running') { exit 1 }")
		}
		if scPath, err := exec.LookPath("sc.exe"); err == nil {
			if err := d.execCommand(scPath, "query", d.reloadCmd); err != nil {
				return fmt.Errorf("windows service %s not installed or queried: %w", d.reloadCmd, err)
			}
			_ = d.execCommand(scPath, "stop", d.reloadCmd)
			return d.execCommand(scPath, "start", d.reloadCmd)
		}
		return fmt.Errorf("service reload unsupported on Windows: neither powershell.exe nor sc.exe found")
	}

	if _, err := exec.LookPath("systemctl"); err == nil {
		return d.execCommand("systemctl", "reload-or-restart", d.reloadCmd)
	}
	return fmt.Errorf("service reload unsupported: systemctl not found")
}
