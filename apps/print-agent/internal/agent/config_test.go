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
