// Package agent implements the Bikri Print Agent: a loopback HTTP service that
// prints through the operating system's installed print queues.
package agent

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const (
	// Protocol is the HTTP API version. Bikri checks it before using the agent.
	Protocol = 1
	// DefaultPort is the loopback port. It is intentionally uncommon.
	DefaultPort = 17890
)

// Config is persisted next to the agent installation. It contains no receipt
// data and no plaintext token: only the SHA-256 hash of the paired token.
type Config struct {
	Version   int      `json:"version"`
	AgentID   string   `json:"agentId"`
	Port      int      `json:"port"`
	Origins   []string `json:"origins"`
	TokenHash string   `json:"tokenHash,omitempty"`
	Paired    bool     `json:"paired"`
	CreatedAt int64    `json:"createdAt"`
}

// DefaultConfig returns a fresh, unpaired configuration.
func DefaultConfig() *Config {
	return &Config{
		Version: Protocol,
		AgentID: randomID(),
		Port:    DefaultPort,
		Origins: []string{
			"https://algovyn.com",
			"http://localhost:5173",
			"http://127.0.0.1:5173",
		},
		CreatedAt: time.Now().UnixMilli(),
	}
}

// DefaultPath is the per-user config path on Windows, Linux and macOS.
func DefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "bikri-print-agent", "config.json"), nil
}

// LoadConfig reads a config file, creating one on first run.
func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		cfg := DefaultConfig()
		if err := SaveConfig(path, cfg); err != nil {
			return nil, err
		}
		return cfg, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.Version == 0 {
		cfg.Version = Protocol
	}
	if cfg.Port == 0 {
		cfg.Port = DefaultPort
	}
	if len(cfg.Origins) == 0 {
		cfg.Origins = DefaultConfig().Origins
	}
	if cfg.AgentID == "" {
		cfg.AgentID = randomID()
	}
	return &cfg, nil
}

// SaveConfig writes the config atomically with owner-only permissions.
func SaveConfig(path string, cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".config-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is fatal for pairing and id generation; a panic
		// here is preferable to running with predictable secrets.
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
