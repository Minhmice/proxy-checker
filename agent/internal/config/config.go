package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type State struct {
	ServerURL            string `json:"server_url"`
	NodeID               string `json:"node_id"`
	NodeName             string `json:"node_name"`
	WireGuardIP          string `json:"wireguard_ip"`
	WireGuardPublicKey   string `json:"wireguard_public_key"`
	WireGuardPrivateKey  string `json:"wireguard_private_key"`
	LastRevision         int64  `json:"last_revision"`
}

type Manager struct {
	dir string
}

func NewManager(dir string) *Manager {
	return &Manager{dir: dir}
}

func (m *Manager) StateFilePath() string {
	return filepath.Join(m.dir, "state.json")
}

func (m *Manager) Load() (*State, error) {
	path := m.StateFilePath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &State{}, nil
		}
		return nil, fmt.Errorf("read state file error: %w", err)
	}

	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode state file error: %w", err)
	}
	return &state, nil
}

func (m *Manager) Save(state *State) error {
	if err := os.MkdirAll(m.dir, 0700); err != nil {
		return fmt.Errorf("create config dir error: %w", err)
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal state error: %w", err)
	}

	tempFile := filepath.Join(m.dir, "state.json.tmp")
	if err := os.WriteFile(tempFile, data, 0600); err != nil {
		return fmt.Errorf("write temp state error: %w", err)
	}

	target := m.StateFilePath()
	if err := os.Rename(tempFile, target); err != nil {
		_ = os.Remove(tempFile)
		return fmt.Errorf("atomic rename state error: %w", err)
	}
	return nil
}
