package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "config.json")
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Version != Protocol || cfg.Port != DefaultPort || cfg.AgentID == "" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.Paired {
		t.Fatal("new config must be unpaired")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("config permissions are too open: %o", info.Mode().Perm())
	}
	cfg.Origins = append(cfg.Origins, "https://example.test")
	if err := SaveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	again, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Origins) != len(cfg.Origins) || again.Origins[len(again.Origins)-1] != "https://example.test" {
		t.Fatalf("origins did not round-trip: %+v", again.Origins)
	}
}

func TestAuthPairAndVerify(t *testing.T) {
	cfg := DefaultConfig()
	auth := NewAuth(cfg)
	code := auth.PairingCode()
	if len(code) != 6 {
		t.Fatalf("pairing code length = %d", len(code))
	}
	if _, err := auth.Pair("000000"); err == nil && code != "000000" {
		t.Fatal("wrong code was accepted")
	}
	token, err := auth.Pair(code)
	if err != nil {
		t.Fatal(err)
	}
	if token == "" || !cfg.Paired || cfg.TokenHash == "" {
		t.Fatal("pairing did not produce a token")
	}
	if cfg.TokenHash == token {
		t.Fatal("token must not be stored in plaintext")
	}
	if !auth.Verify(token) {
		t.Fatal("token did not verify")
	}
	if auth.Verify(token + "x") {
		t.Fatal("wrong token verified")
	}
	if _, err := auth.Pair(code); err == nil {
		t.Fatal("a paired agent accepted another pairing")
	}
	auth.Unpair()
	if auth.Verify(token) {
		t.Fatal("token still works after unpair")
	}
	if auth.PairingCode() == "" {
		t.Fatal("unpair did not create a new code")
	}
}

func TestAuthAttemptLimit(t *testing.T) {
	auth := NewAuth(DefaultConfig())
	code := auth.PairingCode()
	wrong := "000000"
	if code == wrong {
		wrong = "000001"
	}
	for i := 0; i < pairingAttempts; i++ {
		_, _ = auth.Pair(wrong)
	}
	if _, err := auth.Pair(code); err != errTooManyTries {
		t.Fatalf("expected too many attempts, got %v", err)
	}
}

// A failed config write must roll the pairing back, not publish a token that is
// gone after a restart.
func TestPairAndPersistRollsBackWhenTheWriteFails(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig()
	auth := NewAuth(cfg)
	code := auth.PairingCode()
	if _, err := auth.PairAndPersist(filepath.Join(blocker, "config.json"), code); err == nil {
		t.Fatal("pairing with an unwritable config path succeeded")
	}
	if cfg.Paired || cfg.TokenHash != "" {
		t.Fatalf("failed pairing left state behind: %+v", cfg)
	}
	if auth.PairingCode() != code {
		t.Fatal("failed pairing rotated the code instead of rolling back")
	}
	// The same code still pairs once the path is writable.
	token, err := auth.PairAndPersist(filepath.Join(dir, "config.json"), code)
	if err != nil {
		t.Fatal(err)
	}
	if !auth.Verify(token) {
		t.Fatal("persisted token does not verify")
	}
}

// A failed unpair write must not leave a token that only works until restart.
func TestUnpairAndPersistKeepsTheTokenWhenTheWriteFails(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig()
	auth := NewAuth(cfg)
	path := filepath.Join(dir, "config.json")
	token, err := auth.PairAndPersist(path, auth.PairingCode())
	if err != nil {
		t.Fatal(err)
	}
	if err := auth.UnpairAndPersist(filepath.Join(blocker, "config.json")); err == nil {
		t.Fatal("unpair with an unwritable config path succeeded")
	}
	if !cfg.Paired || !auth.Verify(token) {
		t.Fatal("failed unpair revoked the token in memory only")
	}
	// The config on disk still holds the same token hash.
	reloaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.Paired || reloaded.TokenHash != cfg.TokenHash {
		t.Fatal("failed unpair rewrote the persisted config")
	}
	if err := auth.UnpairAndPersist(path); err != nil {
		t.Fatal(err)
	}
	if auth.Verify(token) {
		t.Fatal("token still works after a successful unpair")
	}
}
