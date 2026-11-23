package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultConfigHasNoDeveloperOrigins(t *testing.T) {
	cfg := DefaultConfig()
	if len(cfg.Origins) != 1 || cfg.Origins[0] != "https://algovyn.com" {
		t.Fatalf("default origins = %#v", cfg.Origins)
	}
}

func TestLoadConfigDropsDeveloperOrigins(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := DefaultConfig()
	cfg.Origins = []string{
		"https://algovyn.com",
		"http://localhost:5173",
		"http://127.0.0.1:5173",
		"https://example.test",
	}
	if err := SaveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), ":5173") {
		t.Fatalf("developer origin was persisted: %s", raw)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Origins) != 2 ||
		loaded.Origins[0] != "https://algovyn.com" ||
		loaded.Origins[1] != "https://example.test" {
		t.Fatalf("loaded origins = %#v", loaded.Origins)
	}
}

func TestLoadConfigDoesNotLeaveOriginsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := DefaultConfig()
	cfg.Origins = []string{"http://localhost:5173"}
	if err := SaveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Origins) != 1 || loaded.Origins[0] != "https://algovyn.com" {
		t.Fatalf("loaded origins = %#v", loaded.Origins)
	}
}

func TestTransientOriginsAreNeverPersisted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := DefaultConfig()
	cfg.TransientOrigins = []string{"http://localhost:4173", "http://127.0.0.1:3000"}
	if err := SaveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range cfg.TransientOrigins {
		if strings.Contains(string(raw), origin) {
			t.Fatalf("transient origin was persisted: %s", raw)
		}
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Origins) != 1 || len(loaded.TransientOrigins) != 0 {
		t.Fatalf("loaded origins = %#v / %#v", loaded.Origins, loaded.TransientOrigins)
	}
}

// net.Listen accepts port 0 (an ephemeral port), but the agent's Host check and
// the wizard both assume a fixed, valid TCP port. A hand-edited value must fail
// at load instead of binding the wrong interface or panicking later.
func TestLoadConfigRejectsAnOutOfRangePort(t *testing.T) {
	for _, port := range []int{-1, -17890, 65536, 70000} {
		path := filepath.Join(t.TempDir(), "config.json")
		cfg := DefaultConfig()
		cfg.Port = port
		if err := SaveConfig(path, cfg); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(path); err == nil {
			t.Fatalf("port %d was accepted", port)
		}
	}
	for _, port := range []int{1, 65535} {
		path := filepath.Join(t.TempDir(), "config.json")
		cfg := DefaultConfig()
		cfg.Port = port
		if err := SaveConfig(path, cfg); err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadConfig(path)
		if err != nil {
			t.Fatalf("port %d was rejected: %v", port, err)
		}
		if loaded.Port != port {
			t.Fatalf("port = %d, want %d", loaded.Port, port)
		}
	}
}

// A paired flag with no stored hash cannot authenticate any token; treating it
// as paired hid the pairing code and left the till unable to recover.
func TestLoadConfigClearsPairedWithoutATokenHash(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := DefaultConfig()
	cfg.Paired = true
	cfg.TokenHash = ""
	if err := SaveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Paired {
		t.Fatal("a config without a token hash loaded as paired")
	}
	auth := NewAuth(loaded)
	if auth.PairingCode() == "" {
		t.Fatal("the recovered config does not offer a pairing code")
	}
}
