// Package agent implements the Bikri Print Agent: a loopback HTTP service that
// prints through the operating system's installed print queues.
package agent

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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

	// TransientOrigins are extra browser origins from --allow-origin
	// (development only). They are never written to config.json (14 §7).
	TransientOrigins []string `json:"-"`
}

// developerOrigins were shipped in older builds. A local dev server is an
// allowed browser origin only for the API, and keeping it in a production
// config would let any page on that port drive the agent. Remove it on load;
// developers can add it for one run with --allow-origin.
var developerOrigins = map[string]bool{
	"http://localhost:5173": true,
	"http://127.0.0.1:5173": true,
}

// DefaultConfig returns a fresh, unpaired configuration.
func DefaultConfig() *Config {
	return &Config{
		Version:   Protocol,
		AgentID:   randomID(),
		Port:      DefaultPort,
		Origins:   []string{"https://algovyn.com"},
		CreatedAt: time.Now().UnixMilli(),
	}
}

func sanitizeOrigins(origins []string) []string {
	out := make([]string, 0, len(origins))
	for _, origin := range origins {
		if developerOrigins[origin] {
			continue
		}
		out = append(out, origin)
	}
	if len(out) == 0 {
		out = append(out, "https://algovyn.com")
	}
	return out
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
	if cfg.Port < 1 || cfg.Port > 65535 {
		return nil, fmt.Errorf("config: port %d is outside 1-65535", cfg.Port)
	}
	if len(cfg.Origins) == 0 {
		cfg.Origins = DefaultConfig().Origins
	}
	cfg.Origins = sanitizeOrigins(cfg.Origins)
	if cfg.AgentID == "" {
		cfg.AgentID = randomID()
	}
	// A lost or hand-edited token hash cannot authenticate anyone. Never report
	// the agent as paired (and hide the pairing code) without a stored hash.
	if cfg.TokenHash == "" {
		cfg.Paired = false
	}
	return &cfg, nil
}

// SaveConfig writes the config atomically with owner-only permissions. Developer
// origins added with --allow-origin are transient and never written to disk.
func SaveConfig(path string, cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	saved := *cfg
	saved.Origins = sanitizeOrigins(cfg.Origins)
	saved.TransientOrigins = nil
	data, err := json.MarshalIndent(&saved, "", "  ")
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
	if err := tmp.Sync(); err != nil {
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
